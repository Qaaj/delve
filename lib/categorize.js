/**
 * Email categorization via LM Studio's local OpenAI-compatible server —
 * a real generative LLM, not Ollaya's per-option cross-encoder.
 *
 * response_format: {type: "json_schema", ...} forces the model to emit only
 * valid JSON matching the schema (an enum field literally cannot come back
 * as anything outside its listed options), so this keeps the same
 * "guaranteed-valid category" guarantee Ollaya gave us, just via
 * constrained decoding instead of typed decision primitives.
 *
 * Deliberately no `needs_reply` (dropped per request) and no calibrated
 * confidence scores — a chat-completions JSON response doesn't expose
 * per-field probabilities the way Ollaya's noul/choice did, so
 * domain_confidence/subcategory_confidence are always written as NULL here.
 * is_automated/unsubscribe_candidate/attachment_worth_keeping are hard
 * 1.0/0.0 booleans, not probabilities, despite living in the same REAL
 * columns Ollaya would have filled with calibrated values.
 *
 * v7: ONE call, not two. The original two-stage design (pick `domain`, then
 * ask a second call for `subcategory` constrained to that domain's list) had
 * a real bug: stage 2 only ever saw the winning domain's subcategory list,
 * so a wrong domain pick in stage 1 was structurally unrecoverable — stage 2
 * had no way to reach, say, "survey_feedback" if stage 1 had already
 * committed to "shopping_commerce". Now the model picks `subcategory`
 * directly from the FULL flattened list of every domain's subcategories in
 * one call (SUBCATEGORY_TO_DOMAIN below), and `domain` is derived from
 * whichever one it picked — by construction, domain and subcategory can
 * never disagree, and it's one round trip instead of two.
 *
 * v4 (retained from the two-stage version) adds a handful of extracted facts
 * in the same call: amount/currency, a reference/confirmation number, and up
 * to 2 secondary_domains for emails that genuinely span more than one
 * category (e.g. a flight receipt is both travel and finance_banking). All
 * are nullable/optional — most emails won't have most of these.
 *
 * v11 dropped key_date (was v4's fourth extracted fact): it kept coming back
 * as a fabricated date with no basis in the email body — reproduced across
 * 3 different models/sizes on the same email — worse than not having the
 * field at all. Not retrying this one without a much stronger anti-
 * hallucination instruction, if ever.
 *
 * Bump CATEGORY_VERSION whenever the questions/criteria/backend change — see
 * db/schema.sql's categorize_version comment for why.
 */

const CATEGORY_VERSION = 'v14'; // v1 = abandoned Ollaya attempt, v2 = LM Studio w/ urgency, v3 = +summary, v4 = +amount/currency/reference/key_date/secondary_domains, v5 = expanded shopping_commerce subcategories, v6 = +app_store_purchase, v7 = single-call flat-subcategory (fixes stage-2 domain-gating bug), v8 = dropped unsubscribe_candidate/attachment_worth_keeping, v9 = tightened marketing_newsletter subcategory wording (marketing_promo was over-firing), v10 = tightened freelance_platform wording + cross-domain survey_feedback routing rule, v11 = dropped key_date (hallucination-prone) + shortened all subcategory descriptions, v12 = removed freelance_platform (wrong on 6/6 models tested), v13 = added 7 few-shot examples from real observed failures, placed at end of prompt (closest to generation), v14 = +company (normalized brand/sender name)

const LMSTUDIO_URL   = (process.env.LMSTUDIO_URL || 'http://localhost:1234').replace(/\/+$/, '');
const LMSTUDIO_MODEL = process.env.LMSTUDIO_MODEL || 'qwen/qwen3-vl-4b';
const LMSTUDIO_TIMEOUT_MS = parseInt(process.env.LMSTUDIO_TIMEOUT_MS || '30000', 10);

const DOMAIN_DESCRIPTIONS = {
  shopping_commerce: 'Online purchases, marketplaces, deliveries, returns',
  travel: 'Flights, hotels, transit, itineraries, visas for travel',
  finance_banking: 'Banking, invoices, receipts, tax, investments, insurance, subscriptions',
  freelance_work: 'Freelance client work, contracts, proposals, freelance platforms',
  employment_job: 'Jobs, recruiters, interviews, payslips, employer/colleague mail',
  legal_government: 'Government agencies, taxes, courts, official IDs, immigration',
  housing_rental: 'Rent, leases, landlords, contractors, utilities, real estate',
  health_medical: 'Doctors, pharmacies, medical bills, health insurance, lab results',
  education: 'Courses, schools, certifications, tuition',
  tech_accounts: 'Account security, password resets, software, hosting, app notifications',
  personal_social: 'Friends, family, personal correspondence, community groups, events',
  dating_relationships: 'Dating apps, matches, personal relationship messages',
  marketing_newsletter: 'Newsletters, promotions, sales, surveys, announcements',
  automated_notification: 'Social media alerts, calendar reminders, misc system notices',
  spam: 'Unsolicited, irrelevant, or phishing content',
};

const DOMAINS = Object.keys(DOMAIN_DESCRIPTIONS);

// Descriptions are deliberately terse (a few words) rather than full
// sentences — verbose descriptions (esp. ones with "NOT X, NOT Y" negation
// clauses) turned out to add prompt noise without fixing the misfires they
// were written for (see freelance_platform/marketing_promo history below).
// Short exclusionary hints are kept only where a real, repeatable mix-up was
// observed in testing (marked below); everything else stays compact.
const SUBCATEGORY_CRITERIA = {
  shopping_commerce: {
    amazon_order: 'Amazon order, shipping, or account mail',
    home_improvement: 'Furniture, tools, renovation materials',
    electronics: 'Electronics, gadgets, computer hardware',
    groceries: 'Groceries or food delivery',
    clothing_apparel: 'Clothing or apparel purchase',
    gifts: 'Gift purchased for someone else',
    online_purchase_other: 'Other purchase confirmation',
    shipping_delivery: 'Carrier tracking or delivery notice',
    return_refund: 'Return, refund, or exchange',
  },
  travel: {
    flight_booking: 'Flight reservation or airline update',
    hotel_accommodation: 'Hotel or lodging booking',
    car_rental: 'Car rental booking',
    transit_rideshare: 'Train, bus, taxi, or rideshare booking',
    travel_itinerary: 'General trip itinerary',
    visa_immigration_travel: 'Visa tied to a specific trip',
  },
  finance_banking: {
    bank_statement_alert: 'Bank statement or transaction alert',
    invoice_you_owe: 'Invoice addressed to you for payment',
    invoice_you_sent: 'Invoice you issued to someone else',
    receipt_confirmation: 'Payment or purchase receipt',
    tax_document: 'Tax filing correspondence',
    investment_brokerage: 'Investment or brokerage statement',
    crypto: 'Crypto exchange or wallet correspondence',
    insurance_policy: 'Insurance policy or claim (non-health)',
    subscription_billing: 'Recurring subscription charge',
    overdue_collections: 'Overdue payment reminder',
  },
  freelance_work: {
    // freelance_platform (auto-notices from Upwork/Fiverr-style platforms)
    // removed in v12 — it was picked wrong on every single model tested
    // (6 for 6) for a direct personal quote/invoice email, regardless of
    // wording changes across 4 revisions. Not worth keeping a subcategory
    // nothing can reliably hit; a genuine platform notification (rare in
    // this mailbox so far) will fall into proposal_quote/client_communication
    // instead, which is an acceptable trade for removing a proven bad magnet.
    client_communication: 'Direct email with a freelance client (not a coworker)',
    contract_agreement: 'Freelance contract or agreement',
    proposal_quote: 'Quote or proposal to/from a client',
  },
  employment_job: {
    job_application: 'Job application you submitted',
    recruiter_outreach: 'Recruiter or hiring manager reaching out',
    interview_scheduling: 'Interview scheduling',
    offer_letter: 'Job offer terms',
    payslip_salary: 'Payslip or salary statement',
    colleague_internal: 'Internal work email with a colleague',
  },
  legal_government: {
    government_notice: 'Government agency notice',
    tax_authority: 'Tax authority correspondence',
    court_legal: 'Court filing or legal proceeding',
    id_document: 'Passport/license renewal or issuance',
    immigration_visa_status: 'Immigration/residency status (not trip-specific)',
  },
  housing_rental: {
    lease_contract: 'Rental lease or housing contract',
    landlord_tenant: 'Landlord-tenant communication',
    utilities_bill: 'Utility bill (electric/water/gas/internet)',
    contractor_quote: 'Quote or invoice from a contractor',
    home_maintenance: 'Home repair/maintenance coordination',
    real_estate: 'Property listing, purchase, or sale',
  },
  health_medical: {
    appointment_scheduling: 'Medical appointment scheduling',
    medical_bill: 'Medical bill or statement',
    pharmacy_prescription: 'Pharmacy or prescription mail',
    health_insurance: 'Health insurance correspondence',
    lab_results: 'Lab or test results',
  },
  education: {
    course_enrollment: 'Course enrollment',
    certification: 'Certification or credential',
    school_admin: 'School/college admin mail',
    tuition_payment: 'Tuition payment',
  },
  tech_accounts: {
    account_security: 'Login alert, 2FA code, or security notice',
    password_reset: 'Password reset request',
    service_notification: 'General app/service notification',
    software_license: 'Software purchase direct from vendor',
    app_store_purchase: 'App Store / Google Play purchase',
    domain_hosting: 'Domain registration or web hosting',
  },
  personal_social: {
    personal_correspondence: 'Personal message from a friend',
    family_communication: 'Communication with family',
    social_event: 'Social event invite or coordination',
    community_group: 'Community or interest group mail',
  },
  dating_relationships: {
    dating_platform_match: 'Dating app match or system notification',
    dating_platform_message: 'Message from someone via a dating app',
    relationship_personal: 'Personal relationship correspondence',
  },
  marketing_newsletter: {
    // marketing_promo was over-firing as the domain's default — kept the
    // exclusion hints short instead of dropping them entirely.
    newsletter: 'Recurring digest/subscribed content, not a one-off promo or survey',
    marketing_promo: 'One-off product/sale pitch, not a newsletter/survey/event',
    event_announcement: 'Event, webinar, or launch announcement',
    survey_feedback: 'Rate/review/feedback request, on any topic',
  },
  automated_notification: {
    social_media_notification: 'Social media platform notification',
    calendar_reminder: 'Calendar or scheduling reminder',
    system_alert_misc: 'Other automated system alert',
  },
  spam: {
    spam_generic: 'Generic unsolicited spam',
    phishing_suspicious: 'Suspicious or likely phishing',
  },
};

// Flattened lookups derived from SUBCATEGORY_CRITERIA: every leaf
// subcategory key mapped to its domain and description, and the reverse.
// Subcategory keys are unique across all domains (verified by the throw
// below, which would fire immediately at require-time on a collision).
const SUBCATEGORY_TO_DOMAIN = {};
const ALL_SUBCATEGORIES = {};
for (const [domain, subs] of Object.entries(SUBCATEGORY_CRITERIA)) {
  for (const [key, desc] of Object.entries(subs)) {
    if (SUBCATEGORY_TO_DOMAIN[key]) {
      throw new Error(`Duplicate subcategory key "${key}" in both "${SUBCATEGORY_TO_DOMAIN[key]}" and "${domain}"`);
    }
    SUBCATEGORY_TO_DOMAIN[key] = domain;
    ALL_SUBCATEGORIES[key] = desc;
  }
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Builds the user-message text handed to the model for one email row
 * (expects the columns selected in scripts/categorize.js's SELECT). */
function buildState(email) {
  const body = (email.body_text && email.body_text.trim())
    ? email.body_text
    : stripHtml(email.body_html);

  return [
    `Subject: ${email.subject || ''}`,
    `From: ${email.from_name || ''} <${email.from_address || ''}>`,
    `Has attachment: ${Array.isArray(email.attachments) && email.attachments.length > 0}`,
    `Body: ${(body || '').slice(0, 800)}`,
  ].join('\n');
}

async function callLmStudio(systemPrompt, userContent, schema) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LMSTUDIO_TIMEOUT_MS);
  try {
    const res = await fetch(`${LMSTUDIO_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: LMSTUDIO_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema } },
        temperature: 0,
        // Extended thinking is actively counterproductive here: it's what
        // made gemma-4-31b-qat take 73s/call (vs. ~2s once disabled), and it
        // strips the model's own reasoning trace out of the visible
        // response anyway once response_format forces immediate structured
        // JSON — so there's no upside, only the cost. "off" is rejected by
        // this API ("Supported values: none, minimal, low, medium, high,
        // xhigh") — "none" is the value that actually works. Harmless no-op
        // for models without a reasoning mode at all.
        reasoning_effort: 'none',
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`LM Studio ${res.status}: ${detail.slice(0, 300)}`);
    }
    const body = await res.json();
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('LM Studio response had no message content');
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}

// unsubscribe_candidate and attachment_worth_keeping were dropped from the
// question set (not just left unused) — both were visibly unreliable in
// spot checks (a mailing-list broadcast marked NOT an unsubscribe candidate;
// a decorative image marked worth keeping) and cutting them is also a bet
// that a shorter, less cluttered prompt improves accuracy on what's left.
// Both DB columns stay (harmless NULLs) in case they're worth revisiting
// with better-worded criteria later.
const SCHEMA = {
  type: 'object',
  properties: {
    subcategory: { type: 'string', enum: Object.keys(ALL_SUBCATEGORIES) },
    is_automated: { type: 'boolean' },
    summary: { type: 'string', maxLength: 160 },
    // No nullable ("type": ["x", "null"]) support in this backend's JSON
    // schema engine ("'type' must be a string") — using 0 / "" as the
    // "none" sentinel instead, converted back to real null in categorizeEmail().
    amount: { type: 'number' },
    currency: { type: 'string', pattern: '^([A-Z]{3})?$' },
    reference_number: { type: 'string', maxLength: 60 },
    company: { type: 'string', maxLength: 80 },
    secondary_domains: { type: 'array', items: { type: 'string', enum: DOMAINS }, maxItems: 2 },
  },
  required: [
    'subcategory', 'is_automated', 'summary',
    'amount', 'currency', 'reference_number', 'company', 'secondary_domains',
  ],
};

const SYSTEM_PROMPT = `You are an email triage classifier. Given one email, decide:
- subcategory: the single best-fitting category, chosen directly from this full list (grouped by domain for your reference — the domain itself is derived from whichever subcategory you pick, so just pick the most specific correct one). Note: a request to rate/review/give-feedback always goes to marketing_newsletter/survey_feedback, no matter what topic or service it's about (a medical appointment feedback request is still survey_feedback, not health_medical) — only use a domain-specific option when the email is NOT a feedback/rating request.
  ${DOMAINS.map(d => `${d} (${DOMAIN_DESCRIPTIONS[d]}):\n    ${Object.entries(SUBCATEGORY_CRITERIA[d]).map(([k, v]) => `- ${k}: ${v}`).join('\n    ')}`).join('\n  ')}
- is_automated: true if sent by a system/bot rather than a person
- summary: a plain-English summary of the email in 20 words or fewer
- amount: the monetary amount this email is mainly about (an invoice total, payment, price), as a plain number, or 0 if none
- currency: the 3-letter currency code for "amount" (e.g. "EUR", "USD"), or "" if "amount" is 0
- reference_number: an order/booking/invoice/confirmation number mentioned in the email, or "" if none
- company: the clean brand/company name this email is from or about (e.g. "Amazon", "Lufthansa", "Spotify", "Bandcamp") — normalize it, don't just copy the domain (e.g. "no-reply@email.apple.com" -> "Apple", not "email.apple.com"), or "" if it's a personal email with no relevant company
- secondary_domains: 0-2 additional domains (from: ${DOMAINS.join(', ')}) that also meaningfully apply besides the primary one implied by "subcategory", or an empty array

Examples of correct subcategory picks for tricky/easily-confused emails (from real observed mistakes — pay special attention to these, they are the most common errors):
- "Newsletter #46: AP launches Chainlink node..." -> newsletter (it says "Newsletter" — NOT marketing_promo just because it also mentions a product)
- "Tomorrow: Join us at Meetup #10 - Dogecoin, Berlin" -> event_announcement (has a specific date/time to attend — NOT marketing_promo)
- "Please rate your recent appointment/purchase/service" -> survey_feedback (ANY feedback/rating request, regardless of topic — NOT marketing_promo, NOT a domain-specific option like health_insurance)
- "30% off everything, shop our sale now" -> marketing_promo (a genuine one-off sales pitch with no recurring/event/survey angle — this is what marketing_promo actually is)
- "[App name] notifies you that a friend added something / did something" -> automated_notification (an app activity notification is NOT marketing just because it's automated and comes from a consumer app)
- "Your vaccination/doctor/dentist appointment is confirmed for [date]" -> appointment_scheduling (NOT health_insurance — insurance is only for actual policy/coverage/claim correspondence)
- "Your boarding pass for flight XX123" -> flight_booking (a single specific flight — NOT travel_itinerary, which is for multi-leg/general trip planning content)

Respond only with JSON matching the schema.`;

/** Runs the categorization for one email in a single call and returns a
 * flat object ready to spread into the UPDATE in scripts/categorize.js. */
async function categorizeEmail(email) {
  const state = buildState(email);

  const result = await callLmStudio(SYSTEM_PROMPT, state, SCHEMA);

  const subcategory = Object.prototype.hasOwnProperty.call(ALL_SUBCATEGORIES, result.subcategory) ? result.subcategory : null;
  const domain = subcategory ? SUBCATEGORY_TO_DOMAIN[subcategory] : null;

  const secondaryDomains = Array.isArray(result.secondary_domains)
    ? result.secondary_domains.filter(d => DOMAINS.includes(d) && d !== domain)
    : [];

  return {
    domain,
    domainConfidence: null, // not available from unconstrained chat-completions generation
    subcategory,
    subcategoryConfidence: null,
    urgency: null, // deliberately dropped from the question set
    needsReply: null, // deliberately dropped from the question set
    isAutomated: typeof result.is_automated === 'boolean' ? (result.is_automated ? 1 : 0) : null,
    unsubscribeCandidate: null, // deliberately dropped from the question set — see SCHEMA comment
    attachmentWorthKeeping: null, // deliberately dropped from the question set — see SCHEMA comment
    // 0 / "" are this schema's "none" sentinels (see SCHEMA comment) — convert back to real null here.
    amount: (typeof result.amount === 'number' && result.amount !== 0) ? result.amount : null,
    currency: (typeof result.currency === 'string' && /^[A-Z]{3}$/.test(result.currency)) ? result.currency : null,
    referenceNumber: (typeof result.reference_number === 'string' && result.reference_number.length > 0) ? result.reference_number.slice(0, 60) : null,
    company: (typeof result.company === 'string' && result.company.length > 0) ? result.company.slice(0, 80) : null,
    keyDate: null, // deliberately dropped from the question set — see CATEGORY_VERSION v11 note
    secondaryDomains,
    summary: typeof result.summary === 'string' ? result.summary.slice(0, 500) : null,
    categorizeVersion: CATEGORY_VERSION,
  };
}

module.exports = {
  CATEGORY_VERSION,
  LMSTUDIO_URL,
  LMSTUDIO_MODEL,
  DOMAINS,
  DOMAIN_DESCRIPTIONS,
  SUBCATEGORY_CRITERIA,
  SUBCATEGORY_TO_DOMAIN,
  ALL_SUBCATEGORIES,
  buildState,
  callLmStudio,
  categorizeEmail,
};
