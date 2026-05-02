import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { modmedUrl } = req.body;

  if (!modmedUrl) {
    return res.status(400).json({ error: "ModMed URL is required" });
  }

  try {
    const message = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You are a medical billing assistant for Remagin, an ophthalmology practice. 
          
Given this ModMed patient insurance URL: ${modmedUrl}

Please extract:
1. Patient name
2. Primary insurance (map to one of: Medicare, Humana, UHC, Aetna, Cigna, BCBS/Florida Blue, Ambetter, Curative Administrators, MultiPlan, CoreSource)
3. Any sticky notes about benefits (copay, deductible, OON details)
4. Today's CPT codes from the financials ledger
5. Whether deductible has been met

Then calculate patient responsibility using the Remagin Patient Cost Calculator at:
https://eyesandlids-ux.github.io/patient-calculator/patient_cost_calculator.html

Return a JSON response with:
{
  "patientName": "",
  "insurance": "",
  "cptCodes": [],
  "deductibleMet": true/false,
  "patientOwes": 0.00,
  "insurancePays": 0.00,
  "totalAllowed": 0.00,
  "notes": ""
}`,
        },
      ],
    });

    const response = message.content[0].text;
    res.status(200).json({ result: response });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Failed to process request" });
  }
}