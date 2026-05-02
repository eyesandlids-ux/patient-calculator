import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { patientName, insurance, cptRates, stickyNote, deductible, unknownCodes } = req.body;

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
Remaining Deductible: $${deductible || 0}
Sticky Note: ${stickyNote || "None"}
Unknown codes (exclude from calculation): ${(unknownCodes || []).join(", ") || "None"}

CPT codes and allowed amounts from fee schedule:
${JSON.stringify(cptRates, null, 2)}

Calculate patient responsibility using these EXACT rates. Rules:
- Default: patient pays 20% coinsurance after deductible
- humana: if sticky note has a copay amount, use that as patient responsibility
- If deductible > 0, apply it first before coinsurance kicks in
- If a rate is null or 0, note it separately
- Total all codes together

Return ONLY valid JSON, no other text:
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