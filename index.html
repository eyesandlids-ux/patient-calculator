import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { patientName, insurance, cptRates, stickyNote, deductible, unknownCodes, csType, coinsurancePct, copayAmt } = req.body;

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You are a medical billing assistant for Remagin ophthalmology practice.

Patient: ${patientName}
Insurance: ${insurance}
Cost Sharing Type: ${csType || 'coinsurance'}
Coinsurance %: ${coinsurancePct || 20}
Copay Amount: $${copayAmt || 0}
Remaining Deductible: $${deductible || 0}
Sticky Note: ${stickyNote || "None"}
Unknown codes (exclude): ${(unknownCodes || []).join(", ") || "None"}

CPT codes and allowed amounts:
${JSON.stringify(cptRates, null, 2)}

Calculate patient responsibility using EXACT rates above. Rules:
- coinsurance: patient pays coinsurance% of allowed after deductible
- copay: patient pays fixed copay per visit after deductible
- both: patient pays copay + coinsurance% of allowed after deductible
- none: patient pays $0 (fully covered)
- Apply deductible first before cost sharing
- If humana and sticky note has copay, use that copay amount instead
- Sum all codes together

Return ONLY valid JSON:
{
  "patientName": "",
  "insurance": "",
  "cptCodes": [],
  "deductibleApplied": 0.00,
  "totalAllowed": 0.00,
  "insurancePays": 0.00,
  "patientOwes": 0.00,
  "notes": ""
}`
        }
      ]
    });

    const response = message.content[0].text;
    res.status(200).json({ result: response });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: error.message });
  }
}