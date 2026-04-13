// ════════════════════════════════════════════════════════════════════════════
// BSMNT TOKEN / PAYMENT ENDPOINTS — add to your existing Railway server.js
// ════════════════════════════════════════════════════════════════════════════
//
// 1. npm install stripe @google/generative-ai @supabase/supabase-js
//
// 2. Add to Railway environment variables:
//    STRIPE_SECRET_KEY      — from Stripe dashboard → Developers → API keys
//    STRIPE_WEBHOOK_SECRET  — from Stripe dashboard → Webhooks → signing secret
//    GEMINI_API_KEY         — your platform Gemini key (never sent to client)
//    SUPABASE_URL           — https://fdjnzzrrodrjkngqzewy.supabase.co
//    SUPABASE_SERVICE_KEY   — Supabase → Settings → API → service_role key
//
// 3. In Stripe dashboard → Webhooks → Add endpoint:
//    URL: https://weekbelow-server-production.up.railway.app/stripe-webhook
//    Events: checkout.session.completed
//
// 4. Add these SQL columns in Supabase:
//    ALTER TABLE agency_settings ADD COLUMN IF NOT EXISTS token_balance INTEGER DEFAULT 0;
//    ALTER TABLE agency_settings ADD COLUMN IF NOT EXISTS use_own_key BOOLEAN DEFAULT TRUE;
// ════════════════════════════════════════════════════════════════════════════

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service role bypasses RLS
);

// Token package definitions — adjust prices as you like
const TOKEN_PACKAGES = {
  tokens_10:  { tokens: 40,  priceNzd: 10, name: '40 BSMNT Tokens — $10 NZD' },
  tokens_25:  { tokens: 100, priceNzd: 25, name: '100 BSMNT Tokens — $25 NZD' },
  tokens_50:  { tokens: 200, priceNzd: 50, name: '200 BSMNT Tokens — $50 NZD' },
};

// ── POST /create-checkout ────────────────────────────────────────────────────
// Creates a Stripe Checkout session and returns the redirect URL
async function handleCreateCheckout(req, res) {
  try {
    const { packageId, agencyId, returnUrl } = req.body;
    if (!packageId || !agencyId) {
      return res.status(400).json({ error: 'packageId and agencyId required' });
    }
    const pkg = TOKEN_PACKAGES[packageId];
    if (!pkg) return res.status(400).json({ error: 'Unknown package' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'nzd',           // change to 'usd', 'aud', etc as needed
          product_data: { name: pkg.name, description: pkg.tokens + ' AI storyboard image credits' },
          unit_amount: pkg.priceNzd * 100,  // Stripe uses cents (NZD)
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: (returnUrl || 'https://bsmnt.co.nz') + '?payment=success',
      cancel_url:  (returnUrl || 'https://bsmnt.co.nz') + '?payment=cancelled',
      metadata: { agencyId, packageId, tokens: String(pkg.tokens) },
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error('create-checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ── POST /stripe-webhook ─────────────────────────────────────────────────────
// Receives Stripe events and credits tokens on successful payment
// IMPORTANT: This route must use raw body (not JSON parsed) for signature check
async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Webhook signature failed:', e.message);
    return res.status(400).send('Webhook Error: ' + e.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { agencyId, tokens } = session.metadata || {};
    if (!agencyId || !tokens) return res.json({ received: true });

    const tokensToAdd = parseInt(tokens, 10);
    try {
      // Get current balance
      const { data: current } = await supabaseAdmin
        .from('agency_settings')
        .select('agency_id, token_balance')
        .eq('agency_id', agencyId)
        .maybeSingle();

      const currentBalance = (current && current.token_balance) || 0;
      const newBalance = currentBalance + tokensToAdd;

      if (current) {
        await supabaseAdmin.from('agency_settings')
          .update({ token_balance: newBalance })
          .eq('agency_id', agencyId);
      } else {
        await supabaseAdmin.from('agency_settings')
          .insert({ agency_id: agencyId, token_balance: newBalance });
      }
      console.log(`✅ Credited ${tokensToAdd} tokens to ${agencyId} (new balance: ${newBalance})`);
    } catch (e) {
      console.error('Token credit failed:', e.message);
    }
  }

  res.json({ received: true });
}

// ── POST /generate-image ─────────────────────────────────────────────────────
// Generates a storyboard panel using the platform Gemini key, deducts 1 token
async function handleGenerateImage(req, res) {
  try {
    const { prompt, agencyId } = req.body;
    if (!prompt || !agencyId) {
      return res.status(400).json({ error: 'prompt and agencyId required' });
    }

    // Check and deduct token atomically
    const { data: settings } = await supabaseAdmin
      .from('agency_settings')
      .select('token_balance')
      .eq('agency_id', agencyId)
      .maybeSingle();

    const balance = (settings && settings.token_balance) || 0;
    if (balance <= 0) {
      return res.status(402).json({ error: 'No tokens remaining. Purchase more in the app.' });
    }

    // Deduct first (pessimistic — prevents double-spend)
    const newBalance = balance - 1;
    await supabaseAdmin.from('agency_settings')
      .update({ token_balance: newBalance })
      .eq('agency_id', agencyId);

    // Call Gemini with platform key
    const geminiRes = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-preview-image-generation:generateContent?key=' + process.env.GEMINI_API_KEY,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
        })
      }
    );

    if (!geminiRes.ok) {
      // Refund token if Gemini failed
      await supabaseAdmin.from('agency_settings')
        .update({ token_balance: balance })
        .eq('agency_id', agencyId);
      const err = await geminiRes.text();
      return res.status(500).json({ error: 'Gemini error: ' + err.slice(0, 200) });
    }

    const geminiData = await geminiRes.json();
    const parts = geminiData?.candidates?.[0]?.content?.parts || [];
    const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

    if (!imgPart) {
      // Refund token — no image returned
      await supabaseAdmin.from('agency_settings')
        .update({ token_balance: balance })
        .eq('agency_id', agencyId);
      return res.status(500).json({ error: 'No image returned from Gemini' });
    }

    res.json({
      imageUrl: 'data:' + imgPart.inlineData.mimeType + ';base64,' + imgPart.inlineData.data,
      tokenBalance: newBalance
    });

  } catch (e) {
    console.error('generate-image error:', e.message);
    res.status(500).json({ error: e.message });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// REGISTER ROUTES — paste into your existing Express app setup
// ════════════════════════════════════════════════════════════════════════════

/*
  In your existing server.js, add:

  const express = require('express');
  const app = express();

  // IMPORTANT: webhook must use raw body BEFORE express.json()
  app.post('/stripe-webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);

  // All other routes use JSON body
  app.use(express.json());

  app.post('/create-checkout', handleCreateCheckout);
  app.post('/generate-image',  handleGenerateImage);

  // CORS — allow requests from your app
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
  });
*/

module.exports = { handleCreateCheckout, handleStripeWebhook, handleGenerateImage };
