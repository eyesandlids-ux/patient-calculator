import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXEMPT_CODES = new Set([
  '99202','99203','99204','99205',
  '99212','99213','99214','99215',
  '99222','99223','99231','99024',
  '92002','92004','92012','92014',
  '92083','92082','92081','92136','92250','92133','92134','92132',
  '92025','92020','92285','92225','76514','92071',
]);

function isJCode(code) { return /^J/i.test(code); }
function isExempt(code) { return EXEMPT_CODES.has(code) || isJCode(code); }

function applyMultipleProcedureReduction(cptRates) {
  const exempt = [], nonExempt = [];
  for (const [code, rate] of Object.entries(cptRates)) {
    if (rate === null || rate === undefined) continue;
    if (isExempt(code)) exempt.push({ code, rate: Number(rate) });
    else nonExempt.push({ code, rate: Number(rate) });
  }
  nonExempt.sort((a, b) => b.rate - a.rate);
  const adjustedRates = {}, notes = [];
  for (const { code, rate } of exempt) adjustedRates[code] = rate;
  nonExempt.forEach(({ code, rate }, idx) => {
    const multiplier = idx === 0 ? 1.0 : idx === 1 ? 0.5 : 0.25;
    const adjusted = +(rate * multiplier).toFixed(2);
    adjustedRates[code] = adjusted;
    if (multiplier < 1.0) notes.push(`${code}: reduced to ${Math.round(multiplier*100)}% ($${adjusted.toFixed(2)})`);
  });
  return { adjustedRates, notes };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const {
    patientName, insurance, cptRates, stickyNote,
    deductible = 0, unknownCodes = [], csType = 'coinsurance',
    coinsurancePct = 20, copayAmt = 0, selfPayItems = [],
    secondaryCoverage = 'none', secondaryName = '',
  } = req.body;
  if (!cptRates || Object.keys(cptRates).length === 0)
    return res.status(400).json({ error: 'No CPT rates provided' });

  const { adjustedRates, notes: reductionNotes } = applyMultipleProcedureReduction(cptRates);
  const totalAllowed = Object.values(adjustedRates).reduce((s, v) => s + (v || 0), 0);
  const selfPayTotal = (selfPayItems || []).reduce((s, item) => {
    if (!item || item.code === 'NOCHARGE' || item.code === 'RECHECK') return s;
    return s + (Number(item.charge) || 0);
  }, 0);

  const ded = Number(deductible) || 0;
  let patientCostShare = 0, deductibleApplied = 0, insurancePays = 0;
  if (csType === 'copay') {
    const copay = Number(copayAmt) || 0;
    patientCostShare = copay;
    insurancePays = Math.max(0, totalAllowed - copay);
  } else {
    const pct = Number(coinsurancePct) || 20;
    deductibleApplied = Math.min(ded, totalAllowed);
    const afterDed = Math.max(0, totalAllowed - deductibleApplied);
    const coinsurance = +(afterDed * pct / 100).toFixed(2);
    patientCostShare = +(deductibleApplied + coinsurance).toFixed(2);
    insurancePays = +(totalAllowed - patientCostShare).toFixed(2);
  }
  const patientOwes = +(patientCostShare + selfPayTotal).toFixed(2);

  const codeLines = Object.entries(adjustedRates).map(([code, rate]) => {
    const orig = cptRates[code];
    const reduced = orig !== undefined && +orig !== +rate;
    return `  ${code}: $${rate.toFixed(2)}${reduced ? ` (reduced from $${Number(orig).toFixed(2)})` : ''}`;
  }).join('\n');

  const prompt = `You are a medical billing assistant for Remagin, an ophthalmology practice.

COMPUTED RESULTS (do NOT recalculate — use these exact numbers):
- Insurance: ${insurance}
- Patient: ${patientName || 'Patient'}
- CPT codes with ADJUSTED allowed amounts (multiple-procedure reduction already applied):
${codeLines}
- Total Allowed: $${totalAllowed.toFixed(2)}
- Deductible Applied: $${deductibleApplied.toFixed(2)}
- Insurance Pays: $${insurancePays.toFixed(2)}
- Patient Cost Share (CPT): $${patientCostShare.toFixed(2)}
- Self-Pay Items Total: $${selfPayTotal.toFixed(2)}
- Patient Owes (Total): $${patientOwes.toFixed(2)}
${reductionNotes.length ? `- Reduction notes: ${reductionNotes.join('; ')}` : ''}
${stickyNote ? `\nBenefit note from chart: "${stickyNote}"` : ''}
${unknownCodes.length ? `\nUnknown CPT codes (no rate): ${unknownCodes.join(', ')}` : ''}
${secondaryCoverage !== 'none' ? `\nSecondary insurance (${secondaryName}): coverage = ${secondaryCoverage}` : ''}

Return ONLY this JSON (no extra text):
{
  "patientName": "${patientName || 'Patient'}",
  "insurance": "${insurance}",
  "cptCodes": ${JSON.stringify(Object.keys(adjustedRates))},
  "totalAllowed": ${totalAllowed.toFixed(2)},
  "deductibleApplied": ${deductibleApplied.toFixed(2)},
  "insurancePays": ${insurancePays.toFixed(2)},
  "patientOwes": ${patientOwes.toFixed(2)},
  "notes": "<one sentence: mention any reduction applied, sticky note override, secondary coverage, or unknown codes — blank string if nothing notable>"
}`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });
    return res.status(200).json({ result: message.content[0].text });
  } catch (err) {
    console.error('Anthropic error:', err);
    return res.status(500).json({ error: err.message || 'AI call failed' });
  }
}
