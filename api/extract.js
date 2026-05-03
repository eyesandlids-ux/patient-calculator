import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const INSURANCE_KEYS = {
  "medicare": ["medicare", "first coast", "medicare of florida", "first coast service"],
  "humana": ["humana"],
  "uhc": ["unitedhealthcare", "uhc", "united health", "united healthcare"],
  "aetna": ["aetna"],
  "cigna": ["cigna"],
  "bcbs": ["bcbs", "florida blue", "blue cross", "anthem bcbs", "anthem"],
  "ambetter": ["ambetter", "envolve", "centene", "sunshine health"],
  "multiplan": ["multiplan"],
  "coresource": ["coresource"]
};

function detectInsuranceKey(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const [key, keywords] of Object.entries(INSURANCE_KEYS)) {
    if (keywords.some(kw => lower.includes(kw))) return key;
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { financialsPageText, patientId, todaysDate, todaysDateShort } = req.body;

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You are a medical billing assistant for Remagin ophthalmology practice.

Today's date is ${todaysDate}.

Extract the following information from this ModMed patient financials/ledger page:

LEDGER PAGE:
${financialsPageText?.substring(0, 6000)}

IMPORTANT RULES:
- For todaysCptCodes: ONLY include CPT codes from charges where the DOS column shows ${todaysDateShort} or ${todaysDate}. Look for the date in the first column labeled DOS. If no charges match today's date, return [].
- For primaryInsurance: look for insurance/payer name in the ledger. It may appear on charge lines, in a payer column, or in billing alerts.
- For billingAlert: look for any "Billing Alert" text on the page — this contains important benefit details like copay amounts, deductible status, OOP max.
- For stickyNote: only include if it appears to be recent (within last 30 days based on any date shown). Ignore IOP readings like (-1,-2).
- For hasSecondary: true if any secondary insurance is mentioned.
- csType should be "coinsurance" by default unless billing alert specifies a copay.
- coinsurancePct should be 20 by default for Medicare, otherwise 20.

Return ONLY valid JSON:
{
  "patientName": "Last, First format",
  "primaryInsurance": "insurance name as shown on page",
  "hasSecondary": true or false,
  "billingAlert": "any billing alert text found, or empty string",
  "stickyNote": "recent sticky note text only, or empty string",
  "todaysCptCodes": ["ONLY CPT codes from ${todaysDate}"],
  "deductibleRemaining": 0,
  "copayAmount": 0,
  "csType": "coinsurance or copay or both or none",
  "coinsurancePct": 20,
  "notes": "anything unusual worth flagging"
}`
        }
      ]
    });

    const responseText = message.content[0].text;

    let extracted;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      extracted = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
    } catch(e) {
      throw new Error('Could not parse patient data');
    }

    if (!extracted) throw new Error('No data extracted');

    // Detect insurance key
    const insuranceKey = detectInsuranceKey(extracted.primaryInsurance || '');

    // Use billing alert for benefit details if available, otherwise sticky note
    const benefitDetails = extracted.billingAlert || extracted.stickyNote || '';

    const result = {
      patientName: extracted.patientName,
      insuranceKey: insuranceKey,
      primaryInsurance: extracted.primaryInsurance,
      hasSecondary: extracted.hasSecondary || false,
      stickyNote: benefitDetails,
      cptCodes: extracted.todaysCptCodes || [],
      deductible: extracted.deductibleRemaining || 0,
      copayAmt: extracted.copayAmount || 0,
      csType: extracted.csType || 'coinsurance',
      coinsurancePct: extracted.coinsurancePct || 20,
      notes: extracted.notes || ''
    };

    res.status(200).json(result);

  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: error.message });
  }
}