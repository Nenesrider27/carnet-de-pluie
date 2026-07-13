// supabase/functions/chat/index.ts — proxy Claude pour le chat du Carnet de pluie.
// Garde la clé API Anthropic côté serveur (secret). Le client (PWA) envoie la
// conversation + un contexte ; Claude répond et peut PROPOSER une action
// structurée (enregistrer une absence) que le client applique après confirmation.
//
// Déploiement (voir README) :
//   supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   [ANTHROPIC_MODEL=claude-haiku-4-5]
//   supabase functions deploy chat --no-verify-jwt
//
// Sécurité honnête : l'endpoint est public (le client est une page publique, on
// ne peut pas y cacher un secret). Le vrai garde-fou est un PLAFOND DE DÉPENSE
// sur la clé Anthropic (console.anthropic.com). L'allowlist d'origine ci-dessous
// ne bloque que les appels navigateur d'autres sites.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = Deno.env.get('ANTHROPIC_MODEL') || 'claude-opus-4-8';
const API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';

const ALLOWED_ORIGINS = [
  'https://nenesrider27.github.io',
  'http://localhost:8137',
  'http://localhost:8080',
];

function corsHeaders(origin: string): Record<string, string> {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Content-Type': 'application/json',
  };
}

// Outil : proposer d'enregistrer une absence (fenêtre sans personne au jardin).
const TOOLS = [
  {
    name: 'proposer_action',
    description:
      "Proposer d'enregistrer une ABSENCE : une fenêtre de dates pendant laquelle personne ne pourra arroser le jardin. À utiliser UNIQUEMENT quand l'utilisateur donne des dates claires (ou déductibles depuis aujourd'hui). Le dashboard adaptera alors la reco (ex. « arrose avant de partir » s'il fait chaud).",
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['absence'] },
        debut: { type: 'string', description: "Premier jour d'absence, format AAAA-MM-JJ" },
        fin: { type: 'string', description: 'Dernier jour (jour du retour), format AAAA-MM-JJ' },
        resume: { type: 'string', description: 'Phrase courte confirmant ce qui sera enregistré.' },
      },
      required: ['type', 'debut', 'fin', 'resume'],
      additionalProperties: false,
    },
  },
];

function systemPrompt(context: any): string {
  const c = context || {};
  return [
    "Tu es l'assistant du « Carnet de pluie », un carnet d'arrosage pour un jardin à Anières (Suisse, GE), partagé entre Ernest et son père.",
    "Un moteur déterministe (5 règles + météo MétéoSuisse) calcule DÉJÀ s'il faut arroser et combien de minutes. Tu ne décides JAMAIS la durée toi-même : tu peux seulement rappeler celle du contexte.",
    'Ton rôle :',
    "1) répondre en français, court et concret, aux questions sur l'arrosage ;",
    "2) quand l'utilisateur mentionne une absence (dates où personne n'arrosera), proposer de l'enregistrer via l'outil proposer_action — n'appelle l'outil que si tu as des dates claires ; sinon, demande-les ou conseille simplement.",
    'Sois bref, direct, pas de préambule ni de reformulation inutile. Pas de raisonnement affiché.',
    '',
    'CONTEXTE DU JOUR :',
    `- Aujourd'hui : ${c.today || '?'}`,
    `- Reco actuelle du dashboard : ${c.verdict || '?'}${c.minutes ? ` (~${c.minutes} min)` : ''}`,
    `- Pluie prévue 3 j : ${c.pluie_prevue ?? '?'} mm ; sous 48 h : ${c.pluie_48h ?? '?'} mm`,
    `- Objectif hebdo : ${c.objectif_mm ?? 28} mm ; débit : ${c.debit_mm_h ?? 27} mm/h`,
    `- Arrosages récents : ${c.arrosages_recents || 'aucun'}`,
    `- Absences déjà enregistrées : ${c.contraintes || 'aucune'}`,
  ].join('\n');
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin') || '';
  const cors = corsHeaders(origin);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'Méthode non autorisée' }), { status: 405, headers: cors });
  if (!API_KEY) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY non configurée côté serveur.' }), { status: 500, headers: cors });

  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ error: 'JSON invalide' }), { status: 400, headers: cors }); }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) return new Response(JSON.stringify({ error: 'messages manquant' }), { status: 400, headers: cors });

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemPrompt(body.context),
        tools: TOOLS,
        messages,
      }),
    });

    if (!res.ok) {
      const errTxt = await res.text();
      console.error('Anthropic', res.status, errTxt);
      return new Response(JSON.stringify({ error: `Claude a répondu ${res.status}.` }), { status: 502, headers: cors });
    }

    const data = await res.json();
    let reply = '';
    let action: any = null;
    for (const block of data.content || []) {
      if (block.type === 'text') reply += block.text;
      if (block.type === 'tool_use' && block.name === 'proposer_action') action = block.input;
    }
    return new Response(JSON.stringify({ reply: reply.trim(), action }), { headers: cors });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: 'Erreur réseau vers Claude.' }), { status: 502, headers: cors });
  }
});
