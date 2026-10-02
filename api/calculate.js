import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Codes exempt from multiple procedure reduction — always paid at 100%
const EXEMPT_CODES = new Set([
  // E&M
  '99202','99203','99204','99205',
  '99212','99213','99214','99215',
  '99223','99222','99231','99024',
  // Eye exams
  '92002','92004','92012','92014',
  // Diagnostics / imaging / minor procedures that don't reduce
  '92083','92082','92081','92136','92250','92133','92134','92132',
  '92025','92020','92285','92225','76514','92071',
  // Injections / J-codes handled separately
]);

function isJCode(code) {
  return /^J\d{4}$/.test(code);
}

function applyMultipleProcedureReduction(cptRates, bilateralCodes) {
  // bilateralCodes: set of codes billed with -50 modifier (bilateral)
  // Step 1: calculate effective allowed for each code
  const entries = Object.entries(cptRates).map(([code, rate]) => {
    if (rate === null || rate === undefined) return { code, rate, effective: 0, exempt: true };
    
    const exempt = EXEMPT_CODES.has(code) || isJCode(code);
    let effective = parseFloat(rate) || 0;
    
    // Apply bilateral multiplier first (150% if bilateral)
    if (!exempt && bilateralCodes && bilateralCodes.has(code)) {
      effective = effective * 1.5;
    }
    
    return { code, rate: parseFloat(rate) || 0, effective, exempt };
  });

  // Step 2: separate exempt from non-exempt procedures
  const exempt = entries.filter(e => e.exempt);
  const procedures = entries.filter(e => !e.exempt && e.effective > 0);

  // Step 3: sort procedures by effective allowed amount descending
  procedures.sort((a, b) => b.effective - a.effective);

  // Step 4: apply multiple procedure reduction
  const adjusted = {};
  
  // Exempt codes always at full rate
  exempt.forEach(e => {
    adjusted[e.code] = e.rate;
  });

  // Procedures ranked and reduced
  procedures.forEach((e, index) => {
    let multiplier;
    if (index === 0) multiplier = 1.00;      // 1st procedure: 100%
    else if (index === 1) multiplier = 0.50;  // 2nd procedure: 50%
    else multiplier = 0.25;                   // 3rd+: 25%
    
    adjusted[e.code] = +(e.effective * multiplier).toFixed(2);
  });

  return adjusted;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { 
    patientName, insurance, cptRates, stickyNote, deductible, 
    unknownCodes, csType, coinsurancePct, copayAmt, bilateralCodes 
  } = req.body;

  try {
    // Apply multiple procedure reduction before sending to Claude
    const bilateralSet = bilateralCodes ? new Set(bilateralCodes) : new Set();
    const adjustedRates = applyMultipleProcedureReduction(cptRates, bilateralSet);

    // Build a note about reductions applied for transparency
    const reductionNotes = [];
    const origEntries = Object.entries(cptRates);
    const adjEntries = Object.entries(adjustedRates);
    adjEntries.forEach(([code, adjRate]) => {
      const origRate = parseFloat(cptRates[code]) || 0;
      if (adjRate !== origRate && !EXEMPT_CODES.has(code) && !isJCode(code)) {
        const pct = origRate > 0 ? Math.round((adjRate / origRate) * 100) : 0;
        reductionNotes.push(`${code}: reduced to ${pct}% ($${adjRate.toFixed(2)})`);
      }
    });

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
${reductionNotes.length > 0 ? `Multiple procedure reduction already applied: ${reductionNotes.join(', ')}` : ''}

CPT codes and allowed amounts (already adjusted for multiple procedure reduction):
${JSON.stringify(adjustedRates, null, 2)}

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