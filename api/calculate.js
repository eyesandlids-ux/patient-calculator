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
- coinsurance: apply deductible first, then patient pays coinsurance% of remainder
- copay: patient pays whichever is GREATER — the remaining deductible OR the copay (not both added together). Once deductible is met, patient pays just the copay.
- both: apply deductible first, then patient pays copay + coinsurance% on remainder. Patient pays whichever is greater — deductible or (copay + coinsurance).
- none: patient pays $0
- Key rule: copay counts toward the deductible. Never add deductible + copay together.
- If the sticky note contains specific benefit details (copay amount, deductible info, OOP max, etc.), use those values instead of the default cost sharing settings. The sticky note is the source of truth for patient-specific benefits.
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