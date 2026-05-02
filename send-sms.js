// api/send-sms.js — Fonction Vercel serverless
// Ce fichier doit être placé dans /api/send-sms.js à la racine du projet

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { phone, message } = req.body
  if (!phone || !message) return res.status(400).json({ error: 'phone et message requis' })

  try {
    const response = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: 'GreenKart',
        recipient: phone.replace(/\s/g, ''),
        content: message,
        type: 'transactional',
      }),
    })

    const data = await response.json()

    if (!response.ok) {
      console.error('Brevo error:', data)
      return res.status(response.status).json({ error: data.message || 'Erreur Brevo', data })
    }

    return res.status(200).json({ ok: true, data })
  } catch (err) {
    console.error('SMS error:', err)
    return res.status(500).json({ error: err.message })
  }
}
