import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const INSURANCE_KEYS = {
  "medicare": ["medicare", "first coast", "medicare of florida"],
  "humana": ["humana"],
  "uhc": ["unitedhealthcare", "uhc", "united health"],
  "aetna": ["aetna"],
  "cigna": ["cigna"],
  "bcbs_fs71": ["fs71"],
  "bcbs_fs82": ["fs82"],
  "bcbs_fs91": ["fs91"],
  "ambetter": ["ambetter", "envolve", "centene", "sunshine"],
  "multiplan": ["multiplan"],
  "coresource": ["coresource"]
};

function detectInsuranceKey(text) {
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

  const { insurancePageText, financialsPageText, patientId, todaysDate } = req.body;

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You are a medical billing assistant for Remagin ophthalmology practice.

Extract the following information from these ModMed page texts:

INSURANCE PAGE:
${insurancePageText?.substring(0, 3000)}

FINANCIALS/LEDGER PAGE:
${financialsPageText?.substring(0, 3000)}

Extract and return ONLY valid JSON with these fields:
{
  "patientName": "Last, First format",
  "primaryInsurance": "full insurance name as shown",
  "secondaryInsurance": "full name or null",
  "hasSecondary": true or false,
  "stickyNote": "any benefit notes excluding IOP readings like (-1,-2)",
  "todaysCptCodes": ["ONLY CPT codes from visits dated ${todaysDate}. If no charges exist for today, return empty array []"],
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

    // Build response for popup
    const result = {
      patientName: extracted.patientName,
      insuranceKey: insuranceKey,
      primaryInsurance: extracted.primaryInsurance,
      hasSecondary: extracted.hasSecondary || false,
      stickyNote: extracted.stickyNote || '',
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