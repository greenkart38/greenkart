import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from './supabase'

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const DAYS = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim']
const MONTHS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre']
const MS = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc']

// Horaires par jour : [ouverture, fermeture] (null = fermé sauf exception)
const HORAIRES_BASE = {
  0: null,        // Lundi — fermé (exceptionnel 14-20)
  1: null,        // Mardi — fermé (exceptionnel 14-20)
  2: [14, 22],    // Mercredi
  3: [16, 22],    // Jeudi
  4: [16, 22],    // Vendredi
  5: [14, 22],    // Samedi
  6: [14, 20],    // Dimanche
}
const HORAIRES_VACANCES = [14, 22]
const HORAIRES_EXCEPTIONNEL = [14, 20]
const ENFANT_CLOSE = 18 // sessions enfant max

// Relâches automatiques (hh:mm → {label, dur})
const RELACHES_AUTO = {
  ':00': { label: 'Pause', dur: 15 }, // chaque heure pile
  '19:00': { label: '⛽ Essence', dur: 15 },
  '20:00': { label: '🍽️ Miam', dur: 30 },
}

const DEFAULT_CFG = {
  name: 'Green Kart', city: 'Échirolles',
  kart_adulte: 15, kart_enfant: 12,
  brevo_api_key: '',
  sms: 'Bonjour {nom} ! Réservation confirmée au {karting}.\n{date} à {heure} · {session} ({duree}min) · {participants} pers.\nTotal {total}€ · Acompte {acompte}€ : {lien}',
  sessions: [
    { id:'s1', label:'Découverte', dur:10, price:15, deposit:5, color:'#1D9E75', bg:'#E1F5EE' },
    { id:'s2', label:'Sport', dur:15, price:22, deposit:8, color:'#BA7517', bg:'#FAEEDA' },
    { id:'s3', label:'Compétition', dur:20, price:30, deposit:10, color:'#E24B4A', bg:'#FCEBEB' },
    { id:'s4', label:'Anniversaire', dur:30, price:120, deposit:40, color:'#7F77DD', bg:'#EEEDFE' },
    { id:'s5', label:'Entreprise', dur:60, price:250, deposit:80, color:'#378ADD', bg:'#E6F1FB' },
  ],
  vacances: [], // liste de périodes { start:'YYYY-MM-DD', end:'YYYY-MM-DD', label:'...' }
  jours_exceptionnels: [], // { date:'YYYY-MM-DD', open:14, close:20 }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fmtDate(d) { return d.toISOString().split('T')[0] }
function todayStr() { return fmtDate(new Date()) }

function getWeekStart(d) {
  const nd = new Date(d)
  const day = nd.getDay()
  nd.setDate(nd.getDate() + (day === 0 ? -6 : 1 - day))
  return nd
}
function getWeekDays(d) {
  const ws = getWeekStart(d)
  return Array.from({ length: 7 }, (_, i) => { const dd = new Date(ws); dd.setDate(ws.getDate() + i); return dd })
}

function isVacances(dateStr, vacances = []) {
  return vacances.some(v => dateStr >= v.start && dateStr <= v.end)
}

function getHoraires(dateStr, cfg) {
  // Jour exceptionnel
  const exc = (cfg.jours_exceptionnels || []).find(j => j.date === dateStr)
  if (exc) return [exc.open, exc.close]
  // Vacances
  if (isVacances(dateStr, cfg.vacances)) return HORAIRES_VACANCES
  // Jour normal
  const d = new Date(dateStr + 'T12:00:00')
  const dow = d.getDay() // 0=dim, 1=lun, ...6=sam
  // Convertir en index DAYS (0=lun)
  const idx = dow === 0 ? 6 : dow - 1
  return HORAIRES_BASE[idx] || null
}

function getSlots(open, close) {
  const s = []
  for (let h = open; h < close; h++)
    for (let m = 0; m < 60; m += 15)
      s.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`)
  return s
}

function isRelache(time) {
  // Chaque heure pile
  if (time.endsWith(':00')) return RELACHES_AUTO[':00']
  // Relâches fixes
  if (RELACHES_AUTO[time]) return RELACHES_AUTO[time]
  return null
}

function getNextSlots(startTime, n, slots) {
  const idx = slots.indexOf(startTime)
  if (idx < 0) return []
  const result = []
  let i = idx + 1
  while (result.length < n && i < slots.length) {
    // Sauter les relâches
    if (!isRelache(slots[i])) result.push(slots[i])
    i++
  }
  return result
}

function genIcal(res, cfg) {
  const s = cfg.sessions.find(x => x.id === res.session)
  const dt = new Date(res.date + 'T' + res.time + ':00')
  const dtEnd = new Date(dt.getTime() + (s?.dur || 15) * 60000)
  const fmt = d => d.toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z'
  return `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nDTSTART:${fmt(dt)}\nDTEND:${fmt(dtEnd)}\nSUMMARY:Green Kart - ${res.name}\nDESCRIPTION:${s?.label||''} · ${res.participants} pers.\nLOCATION:Green Kart Échirolles\nEND:VEVENT\nEND:VCALENDAR`
}

async function sendSmsBrevo(apiKey, phone, message) {
  if (!apiKey) return { ok: false, msg: 'Clé Brevo manquante' }
  try {
    const r = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sender: 'GreenKart', recipient: phone, content: message }),
    })
    return { ok: r.ok }
  } catch(e) { return { ok: false, msg: e.message } }
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  app: { fontFamily: '"DM Sans",-apple-system,BlinkMacSystemFont,sans-serif', color: '#1a1a1a', background: '#f7f8fa', minHeight: '100vh', padding: '0 16px 60px' },
  topbar: { display:'flex', alignItems:'center', gap:8, padding:'12px 0 10px', borderBottom:'1px solid #e5e7eb', flexWrap:'wrap' },
  brand: { fontSize:15, fontWeight:700, color:'#111', letterSpacing:'-0.3px' },
  tabs: { display:'flex', gap:2, background:'#f0f1f3', borderRadius:8, padding:3 },
  tab: (active) => ({ padding:'5px 13px', fontSize:12, border:'none', background: active ? '#fff' : 'none', cursor:'pointer', borderRadius:6, fontWeight: active ? 600 : 400, color: active ? '#111' : '#6b7280', boxShadow: active ? '0 1px 3px rgba(0,0,0,0.1)' : 'none', transition:'all 0.15s' }),
  btn: (variant='default') => ({
    background: variant==='primary' ? '#1D9E75' : variant==='danger' ? 'none' : '#fff',
    border: variant==='primary' ? 'none' : variant==='danger' ? '1px solid #fca5a5' : '1px solid #e5e7eb',
    borderRadius:7, padding:'5px 12px', fontSize:12, cursor:'pointer',
    color: variant==='primary' ? '#fff' : variant==='danger' ? '#dc2626' : '#374151',
    fontWeight: variant==='primary' ? 600 : 400, transition:'all 0.15s',
  }),
  cap: { background:'#fff', borderRadius:9, padding:'7px 14px', border:'1px solid #e5e7eb' },
  capLabel: { fontSize:11, color:'#9ca3af', marginBottom:2 },
  capVal: { fontSize:15, fontWeight:700 },
  field: { marginBottom:11 },
  fieldLabel: { display:'block', fontSize:10, color:'#9ca3af', marginBottom:3, textTransform:'uppercase', letterSpacing:'0.5px', fontWeight:600 },
  input: { width:'100%', border:'1px solid #e5e7eb', borderRadius:7, padding:'7px 10px', fontSize:13, fontFamily:'inherit', outline:'none', background:'#fff' },
  modal: { background:'#fff', border:'1px solid #e5e7eb', borderRadius:14, padding:22, width:'min(420px,96vw)', maxHeight:'90vh', overflowY:'auto', boxShadow:'0 24px 64px rgba(0,0,0,0.14)', animation:'fadeIn 0.15s ease' },
  overlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.35)', display:'flex', alignItems:'flex-start', justifyContent:'center', zIndex:1000, paddingTop:36, backdropFilter:'blur(3px)' },
  badge: (bg, color) => ({ display:'inline-block', fontSize:10, padding:'2px 7px', borderRadius:20, fontWeight:600, background:bg, color }),
  row: { display:'flex', alignItems:'center', gap:8, padding:'9px 11px', border:'1px solid #e5e7eb', borderRadius:9, marginBottom:5, background:'#fff', transition:'all 0.15s' },
}

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [cfg, setCfg] = useState(() => {
    try { return { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem('gk_cfg') || '{}') } } catch { return DEFAULT_CFG }
  })
  const [reservations, setReservations] = useState([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('cal')
  const [view, setView] = useState('semaine')
  const [curDate, setCurDate] = useState(new Date())
  const [modal, setModal] = useState(null)
  const [toast, setToast] = useState(null)
  const toastRef = useRef(null)

  useEffect(() => {
    fetchRes()
    const ch = supabase.channel('res')
      .on('postgres_changes', { event:'*', schema:'public', table:'reservations' }, fetchRes)
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [])

  async function fetchRes() {
    const { data, error } = await supabase.from('reservations').select('*')
    if (data) setReservations(data)
    setLoading(false)
  }

  function saveCfg(newCfg) {
    setCfg(newCfg)
    try { localStorage.setItem('gk_cfg', JSON.stringify(newCfg)) } catch {}
  }

  function showToast(msg, type='ok') {
    setToast({ msg, type })
    clearTimeout(toastRef.current)
    toastRef.current = setTimeout(() => setToast(null), 4000)
  }

  function nav(dir) {
    const d = new Date(curDate)
    d.setDate(d.getDate() + dir * (view === 'semaine' ? 7 : 1))
    setCurDate(d)
  }

  const days = view === 'semaine' ? getWeekDays(curDate) : [curDate]
  const ts = todayStr()

  // ─── RESERVATION CRUD ──────────────────────────────────────────────────────
  async function saveReservation(payload) {
    // payload: { dateStr, time, form, sessions: [{dateStr, time, adulte, enfant}] }
    const { dateStr, time, form } = payload
    const sessions = payload.sessions || null

    const s = cfg.sessions.find(x => x.id === form.session) || cfg.sessions[0]
    const id = Date.now().toString(36) + Math.random().toString(36).substr(2,5)

    // Construction de la résa principale
    const resaData = {
      id,
      date: dateStr,
      time,
      name: form.name,
      phone: form.phone,
      email: form.email || null,
      session: s.id,
      notes: form.notes || null,
      deposit_link: `https://pay.greenkart.fr/${id}`,
      arrived: false,
      acompte_paid: false,
      // Nouveau schéma sessions jsonb
      sessions: sessions || [
        {
          dateStr, time,
          adulte: form.kartType === 'adulte' ? parseInt(form.participants) : 0,
          enfant: form.kartType === 'enfant' ? parseInt(form.participants) : 0,
        }
      ],
      // Pour compatibilité ancienne API
      participants: parseInt(form.participants),
      kart_type: form.kartType,
    }

    const { error } = await supabase.from('reservations').insert(resaData)
    if (error) { showToast('❌ Erreur lors de la sauvegarde : ' + error.message, 'err'); return false }

    // SMS Brevo
    if (cfg.brevo_api_key && form.phone) {
      const d = new Date(dateStr + 'T12:00:00')
      const msg = (cfg.sms || '').replace('{nom}', form.name).replace('{karting}', cfg.name + ' ' + cfg.city).replace('{date}', d.toLocaleDateString('fr-FR')).replace('{heure}', time).replace('{session}', s?.label || '').replace('{duree}', s?.dur || '').replace('{participants}', form.participants).replace('{total}', s ? s.price * form.participants : 0).replace('{acompte}', s?.deposit || '').replace('{lien}', `https://pay.greenkart.fr/${id}`)
      const smsRes = await sendSmsBrevo(cfg.brevo_api_key, form.phone, msg)
      showToast(smsRes.ok ? `✓ Réservé · SMS envoyé à ${form.phone}` : `✓ Réservé · SMS échoué (${smsRes.msg || ''})`)
    } else {
      showToast(`✓ Réservation confirmée`)
    }

    setModal(null)
    return true
  }

  async function toggleArrived(id) {
    const r = reservations.find(x => x.id === id)
    if (!r) return
    // Si multi-sessions, cocher toutes les réservations liées (même nom+phone+date)
    const linked = reservations.filter(x => x.name === r.name && x.phone === r.phone && x.date === r.date)
    const newVal = !r.arrived
    for (const lr of linked) {
      await supabase.from('reservations').update({ arrived: newVal }).eq('id', lr.id)
    }
    showToast(newVal ? `✓ ${r.name} est arrivé${linked.length > 1 ? ` (${linked.length} sessions cochées)` : ''}` : `${r.name} marqué en attente`)
  }

  async function toggleAcompte(id) {
    const r = reservations.find(x => x.id === id)
    if (!r) return
    await supabase.from('reservations').update({ acompte_paid: !r.acompte_paid }).eq('id', id)
    showToast(r.acompte_paid ? 'Acompte annulé' : '💳 Acompte reçu')
  }

  async function deleteRes(id) {
    if (!window.confirm('Supprimer cette réservation ?')) return
    await supabase.from('reservations').delete().eq('id', id)
    setModal(null)
    showToast('Réservation supprimée')
  }

  async function updateRes(id, updates) {
    const { error } = await supabase.from('reservations').update(updates).eq('id', id)
    if (error) showToast('❌ Erreur : ' + error.message, 'err')
    else showToast('✓ Mis à jour')
  }

  // ─── HELPERS CALENDRIER ────────────────────────────────────────────────────
  function getResAt(dateStr, time) {
    return reservations.filter(r => r.date === dateStr && r.time === time)
  }
  function getKartCount(dateStr, time, kt) {
    return reservations.filter(r => r.date === dateStr && r.time === time && r.kart_type === kt)
      .reduce((s, r) => s + (r.participants || 1), 0)
  }

  // ─── RENDER ───────────────────────────────────────────────────────────────
  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', flexDirection:'column', gap:16 }}>
      <div style={{ width:32, height:32, border:'3px solid #e5e7eb', borderTop:'3px solid #1D9E75', borderRadius:'50%', animation:'spin 1s linear infinite' }} />
      <div style={{ fontSize:13, color:'#9ca3af' }}>Chargement...</div>
    </div>
  )

  const totalA = reservations.reduce((s,r) => r.kart_type==='adulte' ? s+r.participants : s, 0)
  const totalE = reservations.reduce((s,r) => r.kart_type==='enfant' ? s+r.participants : s, 0)

  return (
    <div style={S.app}>
      {/* TOAST */}
      {toast && (
        <div style={{ position:'fixed', top:16, right:16, zIndex:2000, background:'#fff', border:'1px solid #e5e7eb', borderLeft:`3px solid ${toast.type==='err'?'#dc2626':'#1D9E75'}`, borderRadius:9, padding:'10px 14px', fontSize:13, boxShadow:'0 4px 20px rgba(0,0,0,0.1)', animation:'fadeIn 0.2s ease', maxWidth:320 }}>
          {toast.msg}
        </div>
      )}

      {/* TOPBAR */}
      <div style={S.topbar}>
        <div style={S.brand}>🏎️ {cfg.name} <span style={{ fontSize:12, fontWeight:400, color:'#9ca3af' }}>{cfg.city}</span></div>
        <div style={S.tabs}>
          <button style={S.tab(tab==='cal')} onClick={() => setTab('cal')}>📅 Calendrier</button>
          <button style={S.tab(tab==='today')} onClick={() => setTab('today')}>🏁 Aujourd'hui</button>
          <button style={S.tab(tab==='events')} onClick={() => setTab('events')}>🏆 Événements</button>
        </div>
        {tab === 'cal' && (
          <div style={{ display:'flex', gap:5, alignItems:'center' }}>
            <button style={S.btn()} onClick={() => nav(-1)}>←</button>
            <span style={{ fontSize:12, fontWeight:500, minWidth:145, textAlign:'center' }}>
              {view === 'semaine'
                ? `${days[0].getDate()} ${MS[days[0].getMonth()]} — ${days[6].getDate()} ${MS[days[6].getMonth()]} ${days[6].getFullYear()}`
                : `${curDate.getDate()} ${MONTHS[curDate.getMonth()]} ${curDate.getFullYear()}`}
            </span>
            <button style={S.btn()} onClick={() => nav(1)}>→</button>
            <button style={S.btn()} onClick={() => setCurDate(new Date())}>Auj.</button>
            <button style={S.btn(view==='semaine'?'primary':'default')} onClick={() => setView('semaine')}>Semaine</button>
            <button style={S.btn(view==='jour'?'primary':'default')} onClick={() => setView('jour')}>Jour</button>
          </div>
        )}
        <button style={{ ...S.btn(), marginLeft:'auto' }} onClick={() => setModal({ type:'config' })}>⚙ Config</button>
      </div>

      {/* CAPS */}
      <div style={{ display:'flex', gap:8, marginTop:8, flexWrap:'wrap' }}>
        <div style={S.cap}><div style={S.capLabel}>Karts adulte</div><div style={{ ...S.capVal, color:'#1D9E75' }}>{cfg.kart_adulte} max</div></div>
        <div style={S.cap}><div style={S.capLabel}>Karts enfant</div><div style={{ ...S.capVal, color:'#BA7517' }}>{cfg.kart_enfant} max</div></div>
        <div style={{ ...S.cap, marginLeft:'auto' }}><div style={S.capLabel}>Total réservations</div><div style={S.capVal}>{reservations.length}</div></div>
      </div>

      {/* LÉGENDE */}
      <div style={{ display:'flex', gap:10, padding:'6px 0', borderBottom:'1px solid #e5e7eb', flexWrap:'wrap', fontSize:11, color:'#6b7280', marginTop:6 }}>
        <span style={{ fontWeight:600 }}>Sessions :</span>
        {cfg.sessions.map(s => <span key={s.id}><span style={{ display:'inline-block', width:8, height:8, borderRadius:2, background:s.color, marginRight:4 }} />{s.label} {s.dur}min {s.price}€</span>)}
      </div>

      {/* ── CALENDRIER ── */}
      {tab === 'cal' && (
        <CalView days={days} view={view} cfg={cfg} reservations={reservations} ts={ts}
          setCurDate={setCurDate} setView={setView} setModal={setModal}
          getResAt={getResAt} getKartCount={getKartCount} />
      )}

      {/* ── AUJOURD'HUI ── */}
      {tab === 'today' && (
        <TodayPage cfg={cfg} reservations={reservations}
          toggleArrived={toggleArrived} toggleAcompte={toggleAcompte}
          setModal={setModal} showToast={showToast} />
      )}

      {/* ── ÉVÉNEMENTS ── */}
      {tab === 'events' && (
        <EventsPage cfg={cfg} reservations={reservations} saveReservation={saveReservation} showToast={showToast} setModal={setModal} />
      )}

      {/* ── MODALS ── */}
      {modal && (
        <div style={S.overlay} onClick={() => setModal(null)}>
          <div onClick={e => e.stopPropagation()}>
            {modal.type === 'new' && (
              <NewResModal cfg={cfg} dateStr={modal.dateStr} time={modal.time}
                reservations={reservations} onSave={saveReservation} onClose={() => setModal(null)} />
            )}
            {modal.type === 'detail' && (
              <DetailModal cfg={cfg} res={modal.res}
                onToggleArrived={toggleArrived} onToggleAcompte={toggleAcompte}
                onDelete={deleteRes} onUpdate={updateRes} onClose={() => setModal(null)} showToast={showToast} />
            )}
            {modal.type === 'config' && (
              <ConfigModal cfg={cfg} onSave={saveCfg} onClose={() => setModal(null)} showToast={showToast} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── CAL VIEW ─────────────────────────────────────────────────────────────────
function CalView({ days, view, cfg, reservations, ts, setCurDate, setView, setModal, getResAt, getKartCount }) {
  const slotsPerDay = days.map(d => {
    const ds = fmtDate(d)
    const h = getHoraires(ds, cfg)
    return h ? getSlots(h[0], h[1]) : []
  })
  const allTimes = [...new Set(slotsPerDay.flat())].sort()

  return (
    <div style={{ overflowX:'auto', marginTop:0 }}>
      <div style={{ display:'grid', gridTemplateColumns:`52px repeat(${days.length}, minmax(${view==='jour'?'420px':'96px'}, 1fr))`, minWidth: view==='jour' ? 472 : 720 }}>
        {/* Headers */}
        <div style={{ borderBottom:'1px solid #e5e7eb', position:'sticky', top:0, background:'#f7f8fa', zIndex:10 }} />
        {days.map((d, i) => {
          const ds = fmtDate(d), isT = ds === ts
          const h = getHoraires(ds, cfg)
          const isVac = isVacances(ds, cfg.vacances)
          const ac = reservations.filter(r=>r.date===ds&&r.kart_type==='adulte').reduce((s,r)=>s+r.participants,0)
          const ec = reservations.filter(r=>r.date===ds&&r.kart_type==='enfant').reduce((s,r)=>s+r.participants,0)
          return (
            <div key={i} onClick={() => { if(view==='semaine'){setCurDate(new Date(ds+'T12:00:00'));setView('jour')} }}
              style={{ fontSize:11, color: isT?'#1D9E75':'#9ca3af', padding:'7px 3px 5px', textAlign:'center', borderBottom:'1px solid #e5e7eb', borderLeft:'1px solid #f0f1f3', position:'sticky', top:0, background:'#f7f8fa', zIndex:10, cursor:'pointer' }}>
              <div>{DAYS[i%7]}</div>
              <div style={{ fontSize:18, fontWeight:700, color: isT?'#1D9E75':h?'#111':'#d1d5db', lineHeight:1.1 }}>{d.getDate()}</div>
              {isVac && <div style={{ fontSize:8, color:'#7F77DD', fontWeight:600 }}>VAC</div>}
              {!h && !isVac && <div style={{ fontSize:8, color:'#d1d5db' }}>fermé</div>}
              <div style={{ display:'flex', gap:2, justifyContent:'center', marginTop:2 }}>
                {ac>0 && <span style={{ fontSize:9, background:'#E1F5EE', color:'#0F6E56', padding:'1px 3px', borderRadius:8 }}>A:{ac}</span>}
                {ec>0 && <span style={{ fontSize:9, background:'#FAEEDA', color:'#854F0B', padding:'1px 3px', borderRadius:8 }}>E:{ec}</span>}
              </div>
            </div>
          )
        })}

        {/* Rows */}
        {allTimes.map(time => {
          const isH = time.endsWith(':00')
          return [
            <div key={`t-${time}`} style={{ fontSize:10, color: isH?'#9ca3af':'transparent', textAlign:'right', paddingRight:5, display:'flex', alignItems:'flex-start', justifyContent:'flex-end', paddingTop:2, borderBottom:`1px solid ${isH?'#e5e7eb':'#f3f4f6'}`, height:36 }}>{time}</div>,
            ...days.map((day, di) => {
              const ds = fmtDate(day)
              const daySlots = slotsPerDay[di]
              const inRange = daySlots.includes(time)
              const relache = isRelache(time)
              const sr = getResAt(ds, time)
              const au = getKartCount(ds, time, 'adulte')
              const eu = getKartCount(ds, time, 'enfant')
              const isFermé = !inRange

              return (
                <div key={`s-${time}-${di}`}
                  onClick={() => inRange && !relache && setModal({ type:'new', dateStr:ds, time })}
                  style={{ height:36, borderBottom:`1px solid ${isH?'#e5e7eb':'#f3f4f6'}`, borderLeft:'1px solid #f0f1f3', background: isFermé?'#fafafa':relache?'#FFFBEB':'#fff', position:'relative', cursor: (isFermé||relache)?'default':'pointer' }}
                  onMouseEnter={e => { if(inRange&&!relache) e.currentTarget.style.background='#f7f8fa' }}
                  onMouseLeave={e => { e.currentTarget.style.background = isFermé?'#fafafa':relache?'#FFFBEB':'#fff' }}
                >
                  {isFermé && <div style={{ position:'absolute', inset:0, background:'repeating-linear-gradient(45deg,transparent,transparent 4px,#f3f4f6 4px,#f3f4f6 5px)' }} />}
                  {relache && inRange && (
                    <div style={{ position:'absolute', inset:'2px 2px', borderRadius:3, background:'#FEF3C7', display:'flex', alignItems:'center', padding:'0 6px', fontSize:9, fontWeight:700, color:'#92400E', gap:3 }}>
                      ⏸ {relache.label} {relache.dur}min
                    </div>
                  )}
                  {!relache && inRange && sr.map((r, ri) => {
                    const s = cfg.sessions.find(x => x.id === r.session)
                    const w = 100 / sr.length
                    return (
                      <div key={r.id} onClick={e => { e.stopPropagation(); setModal({ type:'detail', res:r }) }}
                        style={{ position:'absolute', top:2, bottom:2, left:`${ri*w}%`, width:`calc(${w}% - 3px)`, background:s?s.bg:'#f3f4f6', border:`1px solid ${s?s.color:'#e5e7eb'}`, borderRadius:3, padding:'0 4px', fontSize:10, fontWeight:600, color:s?s.color:'#374151', overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis', display:'flex', alignItems:'center', gap:3, cursor:'pointer', opacity:r.arrived?0.5:1, borderTop:r.acompte_paid?`2px solid ${s?s.color:'#1D9E75'}`:undefined }}>
                        <span style={{ fontSize:8, fontWeight:700 }}>{r.kart_type==='adulte'?'A':'E'}</span>
                        {r.arrived?'✓ ':''}{r.name}·{r.participants}p
                      </div>
                    )
                  })}
                </div>
              )
            })
          ]
        })}
      </div>
      <div style={{ display:'flex', gap:14, padding:'7px 0', borderTop:'1px solid #e5e7eb', fontSize:12, color:'#9ca3af', marginTop:4 }}>
        <span>Adulte : {reservations.reduce((s,r)=>r.kart_type==='adulte'?s+r.participants:s,0)} karts réservés</span>
        <span>Enfant : {reservations.reduce((s,r)=>r.kart_type==='enfant'?s+r.participants:s,0)} karts réservés</span>
        <span style={{ marginLeft:'auto' }}>● en direct</span>
      </div>
    </div>
  )
}

// ─── TODAY PAGE ───────────────────────────────────────────────────────────────
function TodayPage({ cfg, reservations, toggleArrived, toggleAcompte, setModal, showToast }) {
  const ts = todayStr()
  const d = new Date()
  const h = getHoraires(ts, cfg)
  const slots = h ? getSlots(h[0], h[1]) : []
  const todayRes = reservations.filter(r => r.date === ts)
  const arrived = todayRes.filter(r => r.arrived).length
  const acomptes = todayRes.filter(r => r.acompte_paid).length

  // Tous les créneaux du jour : slots normaux + créneaux occupés
  const allTimes = [...new Set([...slots, ...todayRes.map(r=>r.time)])].sort()

  return (
    <div style={{ paddingTop:14 }}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:14, flexWrap:'wrap', gap:8 }}>
        <div>
          <div style={{ fontSize:16, fontWeight:700 }}>Aujourd'hui</div>
          <div style={{ fontSize:12, color:'#9ca3af' }}>{d.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</div>
          {!h && <div style={{ fontSize:11, color:'#dc2626', marginTop:2 }}>⚠️ Journée non programmée — créneaux exceptionnels uniquement</div>}
        </div>
        <div style={{ display:'flex', gap:7, flexWrap:'wrap' }}>
          {[['Réservations',todayRes.length,'#111'],['Arrivés',arrived,'#1D9E75'],['En attente',todayRes.length-arrived,'#374151'],['Acomptes',acomptes,'#1D9E75']].map(([l,v,c]) => (
            <div key={l} style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:9, padding:'6px 12px', textAlign:'center' }}>
              <div style={{ fontSize:17, fontWeight:700, color:c }}>{v}</div>
              <div style={{ fontSize:11, color:'#9ca3af' }}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {allTimes.length === 0 && <div style={{ textAlign:'center', padding:'36px 0', color:'#9ca3af', fontSize:13 }}>Aucun créneau aujourd'hui</div>}

      {allTimes.map(time => {
        const relache = h && slots.includes(time) ? isRelache(time) : null
        const inRange = slots.includes(time)
        const slotRes = todayRes.filter(r => r.time === time)

        return (
          <div key={time} style={{ marginBottom:10 }}>
            {/* En-tête créneau */}
            <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', border:`1px solid ${relache?'#FCD34D':'#e5e7eb'}`, borderRadius:8, marginBottom:4, background: relache?'#FFFBEB':'#f9fafb' }}>
              <span style={{ fontSize:13, fontWeight:700, minWidth:44, color:relache?'#92400E':'#6b7280' }}>{time}</span>
              {relache && <span style={{ fontSize:11, fontWeight:700, color:'#92400E' }}>⏸ {relache.label} — {relache.dur}min</span>}
              {!relache && inRange && (
                <div style={{ marginLeft:'auto', display:'flex', gap:5 }}>
                  <button style={S.btn('primary')} onClick={() => setModal({ type:'new', dateStr:ts, time })}>+ Résa</button>
                </div>
              )}
              {!inRange && <span style={{ fontSize:10, color:'#9ca3af', fontStyle:'italic' }}>hors horaires</span>}
            </div>

            {/* Réservations du créneau */}
            {slotRes.map(r => {
              const s = cfg.sessions.find(x => x.id === r.session)
              return (
                <div key={r.id} style={{ ...S.row, marginLeft:16, background: r.arrived?'#f9fafb':'#fff' }}>
                  <div onClick={() => toggleArrived(r.id)}
                    style={{ width:22, height:22, borderRadius:'50%', border:`1.5px solid ${r.arrived?'#1D9E75':'#d1d5db'}`, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, background:r.arrived?'#1D9E75':'none', color:r.arrived?'#fff':'transparent', flexShrink:0 }}>✓</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:600, textDecoration:r.arrived?'line-through':'none', color:r.arrived?'#9ca3af':'#111', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{r.name}</div>
                    <div style={{ fontSize:11, color:'#9ca3af', marginTop:1, display:'flex', gap:5, flexWrap:'wrap', alignItems:'center' }}>
                      <span style={S.badge(s?s.bg:'#f3f4f6', s?s.color:'#374151')}>{s?.label||'?'}</span>
                      <span style={S.badge(r.kart_type==='adulte'?'#E1F5EE':'#FAEEDA', r.kart_type==='adulte'?'#0F6E56':'#854F0B')}>{r.kart_type==='adulte'?'Adulte':'Enfant'}</span>
                      {r.participants} pers · {s?s.price*r.participants:'?'}€{r.phone?' · '+r.phone:''}
                    </div>
                    {r.notes && <div style={{ fontSize:10, color:'#d1d5db', marginTop:1 }}>📝 {r.notes}</div>}
                  </div>
                  <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:5, flexShrink:0 }}>
                    <button onClick={() => toggleAcompte(r.id)}
                      style={{ fontSize:11, padding:'3px 9px', borderRadius:20, border:`1px solid ${r.acompte_paid?'#1D9E75':'#e5e7eb'}`, cursor:'pointer', background:r.acompte_paid?'#E1F5EE':'none', color:r.acompte_paid?'#0F6E56':'#9ca3af', fontWeight:r.acompte_paid?600:400 }}>
                      {r.acompte_paid?'✓ Acompte':'Acompte '+( s?.deposit||'?')+'€'}
                    </button>
                    <button style={S.btn()} onClick={() => setModal({ type:'detail', res:r })}>Détails</button>
                  </div>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ─── EVENTS PAGE ──────────────────────────────────────────────────────────────
function EventsPage({ cfg, reservations, saveReservation, showToast, setModal }) {
  const [eventType, setEventType] = useState('trophee') // trophee | challenge | custom
  const [form, setForm] = useState({
    date: todayStr(), startTime: '14:00',
    name: '', phone: '', email: '',
    adulte: 0, enfant: 0,
    // Trophée : 10min chrono + 12min course
    // Challenge : 10min essai + 10min chrono + 12min course
    customSessions: [], // [{adulte, enfant, label, dur}]
    pauseBetween: 5, // minutes de pause entre sessions
    notes: '',
  })

  const EVENT_TYPES = {
    trophee: {
      label: '🏆 Trophée',
      desc: 'Chrono 10min + Course 12min + 1 pause entre chaque session',
      sessions: [
        { label: 'Chrono', dur: 10 },
        { label: 'Course', dur: 12 },
      ]
    },
    challenge: {
      label: '⚡ Challenge',
      desc: 'Essai 10min + Chrono 10min + Course 12min',
      sessions: [
        { label: 'Essai', dur: 10 },
        { label: 'Chrono', dur: 10 },
        { label: 'Course', dur: 12 },
      ]
    },
    custom: {
      label: '✏️ Sur mesure',
      desc: 'Configurez vos propres sessions',
      sessions: []
    }
  }

  const currentType = EVENT_TYPES[eventType]
  const sessions = eventType === 'custom' ? form.customSessions : currentType.sessions

  function addCustomSession() {
    setForm(f => ({ ...f, customSessions: [...f.customSessions, { label: 'Session', dur: 10, adulte: 0, enfant: 0 }] }))
  }
  function updCustomSession(idx, field, val) {
    setForm(f => {
      const cs = [...f.customSessions]
      cs[idx] = { ...cs[idx], [field]: val }
      return { ...f, customSessions: cs }
    })
  }
  function removeCustomSession(idx) {
    setForm(f => ({ ...f, customSessions: f.customSessions.filter((_,i)=>i!==idx) }))
  }

  // Calcul des créneaux horaires pour l'événement
  function computeSlots() {
    const [startH, startM] = form.startTime.split(':').map(Number)
    let cursor = startH * 60 + startM
    const result = []
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]
      const timeStr = `${String(Math.floor(cursor/60)).padStart(2,'0')}:${String(cursor%60).padStart(2,'0')}`
      result.push({ ...s, time: timeStr })
      cursor += s.dur
      if (i < sessions.length - 1) cursor += parseInt(form.pauseBetween) || 0 // pause
    }
    return result
  }

  const slots = computeSlots()

  async function handleCreateEvent() {
    if (!form.name.trim() || !form.phone.trim()) { alert('Nom et téléphone obligatoires.'); return }
    if (sessions.length === 0) { alert('Ajoutez au moins une session.'); return }
    if (!form.adulte && !form.enfant) { alert('Ajoutez des participants.'); return }

    let ok = true
    for (const slot of slots) {
      const adulte = eventType === 'custom' ? (slot.adulte || parseInt(form.adulte) || 0) : parseInt(form.adulte) || 0
      const enfant = eventType === 'custom' ? (slot.enfant || parseInt(form.enfant) || 0) : parseInt(form.enfant) || 0
      const participants = adulte + enfant
      const kartType = adulte >= enfant ? 'adulte' : 'enfant'

      const res = await saveReservation({
        dateStr: form.date,
        time: slot.time,
        form: {
          name: form.name,
          phone: form.phone,
          email: form.email,
          session: cfg.sessions[0]?.id,
          kartType,
          participants,
          notes: `${currentType.label} · ${slot.label}${form.notes ? ' · ' + form.notes : ''}`,
        },
        sessions: [{ dateStr: form.date, time: slot.time, adulte, enfant }]
      })
      if (!res) { ok = false; break }
    }

    if (ok) {
      // Ajout au calendrier iCal
      const icalContent = slots.map(slot => {
        const dt = new Date(form.date + 'T' + slot.time + ':00')
        const dtEnd = new Date(dt.getTime() + slot.dur * 60000)
        const fmt = d => d.toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z'
        return `BEGIN:VEVENT\nDTSTART:${fmt(dt)}\nDTEND:${fmt(dtEnd)}\nSUMMARY:GreenKart - ${currentType.label} - ${slot.label}\nDESCRIPTION:${form.name} · ${parseInt(form.adulte)+parseInt(form.enfant)} pers.\nLOCATION:Green Kart Échirolles\nEND:VEVENT`
      }).join('\n')
      const ical = `BEGIN:VCALENDAR\nVERSION:2.0\n${icalContent}\nEND:VCALENDAR`
      const blob = new Blob([ical], { type: 'text/calendar' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `greenkart-event-${form.date}.ics`; a.click()
      showToast(`✓ Événement créé · Calendrier téléchargé`)
    }
  }

  return (
    <div style={{ paddingTop:14, maxWidth:560 }}>
      <div style={{ fontSize:15, fontWeight:700, marginBottom:4 }}>Créer un événement</div>
      <div style={{ fontSize:12, color:'#9ca3af', marginBottom:16 }}>Trophée, Challenge ou événement sur mesure · Ajout auto au calendrier</div>

      {/* Type d'événement */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:7, marginBottom:16 }}>
        {Object.entries(EVENT_TYPES).map(([k, et]) => (
          <div key={k} onClick={() => setEventType(k)}
            style={{ border:`${eventType===k?'2px':'1px'} solid ${eventType===k?'#1D9E75':'#e5e7eb'}`, borderRadius:9, padding:'10px 12px', cursor:'pointer', background:eventType===k?'#E1F5EE':'#fff' }}>
            <div style={{ fontSize:13, fontWeight:700, color:eventType===k?'#1D9E75':'#111' }}>{et.label}</div>
            <div style={{ fontSize:10, color:'#9ca3af', marginTop:3, lineHeight:1.4 }}>{et.desc}</div>
          </div>
        ))}
      </div>

      {/* Dates & horaires */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9, marginBottom:9 }}>
        <div style={S.field}><label style={S.fieldLabel}>Date</label>
          <input style={S.input} type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} />
        </div>
        <div style={S.field}><label style={S.fieldLabel}>Heure de début</label>
          <input style={S.input} type="time" value={form.startTime} onChange={e=>setForm(f=>({...f,startTime:e.target.value}))} />
        </div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9, marginBottom:9 }}>
        <div style={S.field}><label style={S.fieldLabel}>Pause entre sessions (min)</label>
          <input style={S.input} type="number" min={0} max={30} value={form.pauseBetween} onChange={e=>setForm(f=>({...f,pauseBetween:e.target.value}))} />
        </div>
      </div>

      {/* Sessions custom */}
      {eventType === 'custom' && (
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:12, fontWeight:600, marginBottom:7 }}>Sessions</div>
          {form.customSessions.map((cs, i) => (
            <div key={i} style={{ display:'flex', gap:6, alignItems:'center', marginBottom:6, flexWrap:'wrap' }}>
              <input style={{ ...S.input, width:120 }} placeholder="Nom" value={cs.label} onChange={e=>updCustomSession(i,'label',e.target.value)} />
              <input style={{ ...S.input, width:70 }} type="number" min={1} placeholder="Durée" value={cs.dur} onChange={e=>updCustomSession(i,'dur',+e.target.value)} />
              <span style={{ fontSize:11, color:'#9ca3af' }}>min</span>
              <button style={S.btn('danger')} onClick={()=>removeCustomSession(i)}>✕</button>
            </div>
          ))}
          <button style={S.btn()} onClick={addCustomSession}>+ Ajouter session</button>
        </div>
      )}

      {/* Prévisualisation des créneaux */}
      {sessions.length > 0 && (
        <div style={{ background:'#f9fafb', borderRadius:9, padding:'10px 12px', marginBottom:12, border:'1px solid #e5e7eb' }}>
          <div style={{ fontSize:11, fontWeight:700, color:'#6b7280', marginBottom:7, textTransform:'uppercase', letterSpacing:'0.5px' }}>Créneaux générés</div>
          {slots.map((s, i) => (
            <div key={i} style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, marginBottom:4 }}>
              <span style={{ fontWeight:700, color:'#1D9E75', minWidth:44 }}>{s.time}</span>
              <span>{s.label}</span>
              <span style={{ color:'#9ca3af' }}>{s.dur}min</span>
            </div>
          ))}
        </div>
      )}

      {/* Client */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9 }}>
        <div style={S.field}><label style={S.fieldLabel}>Nom *</label><input style={S.input} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="Jean Dupont" /></div>
        <div style={S.field}><label style={S.fieldLabel}>Téléphone *</label><input style={S.input} value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} placeholder="+33 6 12 34 56 78" /></div>
        <div style={S.field}><label style={S.fieldLabel}>Email</label><input style={S.input} type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="jean@email.fr" /></div>
        <div style={S.field}><label style={S.fieldLabel}>Adultes</label><input style={S.input} type="number" min={0} value={form.adulte} onChange={e=>setForm(f=>({...f,adulte:e.target.value}))} /></div>
        <div style={S.field}><label style={S.fieldLabel}>Enfants</label><input style={S.input} type="number" min={0} value={form.enfant} onChange={e=>setForm(f=>({...f,enfant:e.target.value}))} /></div>
      </div>
      <div style={S.field}><label style={S.fieldLabel}>Notes</label><textarea style={{ ...S.input, height:52, resize:'vertical' }} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} /></div>

      <button style={{ ...S.btn('primary'), padding:'10px 24px', fontSize:13, width:'100%', marginTop:4 }} onClick={handleCreateEvent}>
        🏁 Créer l'événement + Ajouter au calendrier
      </button>
    </div>
  )
}

// ─── NEW RES MODAL ────────────────────────────────────────────────────────────
function NewResModal({ cfg, dateStr, time, reservations, onSave, onClose }) {
  const d = new Date(dateStr + 'T12:00:00')
  const h = getHoraires(dateStr, cfg)
  const slots = h ? getSlots(h[0], h[1]).filter(s => !isRelache(s)) : []

  const [form, setForm] = useState({
    name: '', phone: '', email: '',
    session: cfg.sessions[0]?.id || '',
    kartType: 'adulte', participants: 1,
    notes: '',
    // Multi-sessions
    nbSessionsAdulte: 1,
    nbSessionsEnfant: 0,
    mixte: false, // adulte ET enfant
  })

  // Calcul dispo
  const au = reservations.filter(r=>r.date===dateStr&&r.time===time&&r.kart_type==='adulte').reduce((s,r)=>s+r.participants,0)
  const eu = reservations.filter(r=>r.date===dateStr&&r.time===time&&r.kart_type==='enfant').reduce((s,r)=>s+r.participants,0)
  const ar = cfg.kart_adulte - au
  const er = cfg.kart_enfant - eu

  // Sessions générées (multi)
  const s = cfg.sessions.find(x => x.id === form.session) || cfg.sessions[0]

  function buildSessions() {
    const result = []
    const nextSlots = getNextSlots(time, Math.max(form.nbSessionsAdulte, form.nbSessionsEnfant) - 1, slots)
    const allSlots = [time, ...nextSlots]

    for (let i = 0; i < Math.max(form.nbSessionsAdulte, form.nbSessionsEnfant); i++) {
      const t = allSlots[i] || allSlots[allSlots.length - 1]
      result.push({
        dateStr,
        time: t,
        adulte: i < form.nbSessionsAdulte ? parseInt(form.participants) : 0,
        enfant: form.mixte && i < form.nbSessionsEnfant ? parseInt(form.enfantParticipants || form.participants) : 0,
      })
    }
    return result
  }

  const previewSessions = form.nbSessionsAdulte > 1 || form.nbSessionsEnfant > 0 ? buildSessions() : null

  // SMS preview
  const msg = (cfg.sms || '').replace('{nom}', form.name || '[Nom]').replace('{karting}', cfg.name + ' ' + cfg.city).replace('{date}', d.toLocaleDateString('fr-FR')).replace('{heure}', time).replace('{session}', s?.label || '').replace('{duree}', s?.dur || '').replace('{participants}', form.participants).replace('{total}', s ? s.price * form.participants : 0).replace('{acompte}', s?.deposit || '').replace('{lien}', '[lien paiement]')

  function handleSave() {
    if (!form.name.trim() || !form.phone.trim()) { alert('Nom et téléphone obligatoires.'); return }
    const used = form.kartType === 'adulte' ? au : eu
    const max = form.kartType === 'adulte' ? cfg.kart_adulte : cfg.kart_enfant
    if (used + parseInt(form.participants) > max) { alert(`Capacité dépassée ! ${max - used} kart(s) dispo.`); return }

    const sessions = previewSessions || [{ dateStr, time, adulte: form.kartType==='adulte'?parseInt(form.participants):0, enfant: form.kartType==='enfant'?parseInt(form.participants):0 }]
    onSave({ dateStr, time, form, sessions })
  }

  return (
    <div style={S.modal}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
        <h3 style={{ fontSize:15, fontWeight:700 }}>Nouvelle réservation</h3>
        <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#9ca3af' }}>✕</button>
      </div>
      <div style={{ fontSize:12, color:'#9ca3af', marginBottom:13 }}>
        {d.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})} à {time}
      </div>

      {/* Type kart */}
      <div style={S.field}>
        <label style={S.fieldLabel}>Type de kart</label>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
          {[{id:'adulte',label:'Adulte',rem:ar,max:cfg.kart_adulte,c:'#1D9E75'},{id:'enfant',label:'Enfant',rem:er,max:cfg.kart_enfant,c:'#BA7517'}].map(kt => (
            <div key={kt.id} onClick={() => setForm(f=>({...f,kartType:kt.id}))}
              style={{ border:`${form.kartType===kt.id?'2px':'1px'} solid ${form.kartType===kt.id?kt.c:'#e5e7eb'}`, borderRadius:7, padding:'8px 10px', cursor:'pointer', background:form.kartType===kt.id?kt.c+'11':'#fff' }}>
              <div style={{ fontSize:12, fontWeight:600 }}>{kt.label}</div>
              <div style={{ fontSize:11, color:kt.rem<=3?'#dc2626':kt.c }}>{kt.rem}/{kt.max} dispo</div>
            </div>
          ))}
        </div>
      </div>

      {/* Session */}
      <div style={S.field}>
        <label style={S.fieldLabel}>Session</label>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:5 }}>
          {cfg.sessions.map(ss => {
            // Bloquer sessions enfant après ENFANT_CLOSE si type enfant
            const isEnfantLate = form.kartType === 'enfant' && time >= `${ENFANT_CLOSE}:00`
            return (
              <div key={ss.id} onClick={() => !isEnfantLate && setForm(f=>({...f,session:ss.id}))}
                style={{ border:`${form.session===ss.id?'2px':'1px'} solid ${form.session===ss.id?ss.color:'#e5e7eb'}`, borderRadius:7, padding:'7px 9px', cursor:isEnfantLate?'not-allowed':'pointer', background:isEnfantLate?'#f9fafb':form.session===ss.id?ss.color+'11':'#fff', opacity:isEnfantLate?0.4:1 }}>
                <div style={{ fontSize:12, fontWeight:600, color:ss.color }}>{ss.label}</div>
                <div style={{ fontSize:11, color:'#9ca3af' }}>{ss.dur}min · {ss.price}€</div>
              </div>
            )
          })}
        </div>
        {form.kartType === 'enfant' && time >= `${ENFANT_CLOSE}:00` && (
          <div style={{ fontSize:11, color:'#dc2626', marginTop:5 }}>⚠️ Sessions enfant disponibles jusqu'à {ENFANT_CLOSE}h uniquement</div>
        )}
      </div>

      {/* Multi-sessions */}
      <div style={{ background:'#f9fafb', borderRadius:9, padding:'10px 12px', marginBottom:12, border:'1px solid #e5e7eb' }}>
        <div style={{ fontSize:12, fontWeight:700, marginBottom:8 }}>🔄 Multi-sessions</div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9 }}>
          <div><label style={S.fieldLabel}>Nb sessions adulte</label>
            <input style={S.input} type="number" min={0} max={10} value={form.nbSessionsAdulte}
              onChange={e=>setForm(f=>({...f,nbSessionsAdulte:parseInt(e.target.value)||0}))} />
          </div>
          <div><label style={S.fieldLabel}>Nb sessions enfant</label>
            <input style={S.input} type="number" min={0} max={10} value={form.nbSessionsEnfant}
              onChange={e=>setForm(f=>({...f,nbSessionsEnfant:parseInt(e.target.value)||0}))} />
          </div>
        </div>
        {previewSessions && (
          <div style={{ marginTop:8 }}>
            <div style={{ fontSize:10, color:'#9ca3af', marginBottom:5, fontWeight:600, textTransform:'uppercase' }}>Créneaux auto</div>
            {previewSessions.map((ps, i) => (
              <div key={i} style={{ display:'flex', gap:10, fontSize:11, marginBottom:3 }}>
                <span style={{ fontWeight:700, color:'#1D9E75', minWidth:40 }}>{ps.time}</span>
                {ps.adulte > 0 && <span style={S.badge('#E1F5EE','#0F6E56')}>A:{ps.adulte}</span>}
                {ps.enfant > 0 && <span style={S.badge('#FAEEDA','#854F0B')}>E:{ps.enfant}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Client */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9 }}>
        <div style={S.field}><label style={S.fieldLabel}>Nom *</label><input style={S.input} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="Jean Dupont" /></div>
        <div style={S.field}><label style={S.fieldLabel}>Participants</label><input style={S.input} type="number" min={1} max={20} value={form.participants} onChange={e=>setForm(f=>({...f,participants:e.target.value}))} /></div>
        <div style={S.field}><label style={S.fieldLabel}>Téléphone *</label><input style={S.input} value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} placeholder="+33 6 12 34 56 78" /></div>
        <div style={S.field}><label style={S.fieldLabel}>Email</label><input style={S.input} type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="jean@email.fr" /></div>
      </div>
      <div style={S.field}><label style={S.fieldLabel}>Notes internes</label><textarea style={{ ...S.input, height:50, resize:'vertical' }} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} /></div>

      {/* SMS preview */}
      <div style={{ background:'#f9fafb', borderRadius:8, padding:'9px 11px', fontSize:12, lineHeight:1.75, color:'#6b7280', marginBottom:12 }}>
        <strong style={{ color:'#374151' }}>SMS client :</strong><br />
        {msg.split('\n').map((l,i) => <span key={i}>{l}<br /></span>)}
        {form.phone && <span style={{ fontSize:10, color:'#d1d5db' }}>→ {form.phone}{cfg.brevo_api_key ? '' : ' (Brevo non configuré)'}</span>}
      </div>

      <div style={{ display:'flex', gap:7, justifyContent:'flex-end' }}>
        <button style={S.btn()} onClick={onClose}>Annuler</button>
        <button style={S.btn('primary')} onClick={handleSave}>Confirmer {cfg.brevo_api_key ? '+ SMS' : ''}</button>
      </div>
    </div>
  )
}

// ─── DETAIL MODAL ─────────────────────────────────────────────────────────────
function DetailModal({ cfg, res, onToggleArrived, onToggleAcompte, onDelete, onUpdate, onClose, showToast }) {
  const s = cfg.sessions.find(x => x.id === res.session)
  const d = new Date(res.date + 'T12:00:00')
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({ participants: res.participants, date: res.date, time: res.time, notes: res.notes || '' })

  function downloadCal() {
    const ical = genIcal(res, cfg)
    const blob = new Blob([ical], { type: 'text/calendar' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `greenkart-${res.id}.ics`; a.click()
  }

  async function handleUpdate() {
    await onUpdate(res.id, { participants: parseInt(editForm.participants), date: editForm.date, time: editForm.time, notes: editForm.notes })
    setEditing(false)
  }

  return (
    <div style={S.modal}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
        <h3 style={{ fontSize:15, fontWeight:700 }}>{res.name}</h3>
        <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#9ca3af' }}>✕</button>
      </div>
      <div style={{ fontSize:12, color:'#9ca3af', marginBottom:12 }}>
        {d.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})} à {res.time}
      </div>

      <div style={{ display:'flex', gap:6, marginBottom:13, flexWrap:'wrap' }}>
        <span style={{ fontSize:12, padding:'4px 10px', borderRadius:20, background:res.arrived?'#E1F5EE':'#f3f4f6', color:res.arrived?'#0F6E56':'#6b7280' }}>{res.arrived?'✓ Arrivé':'En attente'}</span>
        <span style={{ fontSize:12, padding:'4px 10px', borderRadius:20, background:res.acompte_paid?'#E1F5EE':'#f3f4f6', color:res.acompte_paid?'#0F6E56':'#6b7280' }}>💳 {res.acompte_paid?'Acompte reçu':'Acompte en attente'}</span>
      </div>

      {editing ? (
        <div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9 }}>
            <div style={S.field}><label style={S.fieldLabel}>Date</label><input style={S.input} type="date" value={editForm.date} onChange={e=>setEditForm(f=>({...f,date:e.target.value}))} /></div>
            <div style={S.field}><label style={S.fieldLabel}>Heure</label><input style={S.input} type="time" value={editForm.time} onChange={e=>setEditForm(f=>({...f,time:e.target.value}))} /></div>
            <div style={S.field}><label style={S.fieldLabel}>Participants</label><input style={S.input} type="number" min={1} value={editForm.participants} onChange={e=>setEditForm(f=>({...f,participants:e.target.value}))} /></div>
          </div>
          <div style={S.field}><label style={S.fieldLabel}>Notes</label><textarea style={{ ...S.input, height:50, resize:'vertical' }} value={editForm.notes} onChange={e=>setEditForm(f=>({...f,notes:e.target.value}))} /></div>
          <div style={{ display:'flex', gap:6, marginBottom:12 }}>
            <button style={S.btn()} onClick={() => setEditing(false)}>Annuler</button>
            <button style={S.btn('primary')} onClick={handleUpdate}>Enregistrer</button>
          </div>
        </div>
      ) : (
        <>
          {[
            ['Session', s ? <span style={S.badge(s.bg, s.color)}>{s.label}</span> : '—'],
            ['Kart', res.kart_type === 'adulte' ? 'Adulte' : 'Enfant'],
            ['Durée', s ? s.dur + 'min' : '—'],
            ['Participants', res.participants],
            ['Total', s ? s.price * res.participants + '€' : '—'],
            ['Acompte', s ? s.deposit + '€' : '—'],
            ['Téléphone', res.phone],
            ['Email', res.email || '—'],
          ].map(([l, v]) => (
            <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:'1px solid #f3f4f6', fontSize:13 }}>
              <span style={{ color:'#9ca3af' }}>{l}</span><span>{v}</span>
            </div>
          ))}
          {res.notes && <div style={{ marginTop:8, padding:'7px 9px', background:'#f9fafb', borderRadius:7, fontSize:12, color:'#6b7280' }}>📝 {res.notes}</div>}
          <div style={{ background:'#f9fafb', borderRadius:7, padding:'7px 10px', fontSize:11, margin:'12px 0' }}>
            <div style={{ color:'#9ca3af', marginBottom:2 }}>Lien acompte</div>
            <div style={{ color:'#1D9E75', wordBreak:'break-all' }}>{res.deposit_link}</div>
          </div>
        </>
      )}

      <div style={{ display:'flex', gap:6, justifyContent:'flex-end', flexWrap:'wrap' }}>
        <button style={S.btn('danger')} onClick={() => onDelete(res.id)}>Supprimer</button>
        <button style={S.btn()} onClick={() => setEditing(!editing)}>✏️ Modifier</button>
        <button style={S.btn()} onClick={downloadCal}>📅 Calendrier</button>
        <button style={S.btn()} onClick={() => onToggleAcompte(res.id)}>{res.acompte_paid ? 'Annuler acompte' : '✓ Acompte'}</button>
        <button style={S.btn()} onClick={() => onToggleArrived(res.id)}>{res.arrived ? 'Annuler arrivée' : '✓ Arrivé'}</button>
        <button style={S.btn('primary')} onClick={() => { showToast(`SMS renvoyé → ${res.phone}`); onClose() }}>Renvoyer SMS</button>
      </div>
    </div>
  )
}

// ─── CONFIG MODAL ─────────────────────────────────────────────────────────────
function ConfigModal({ cfg, onSave, onClose, showToast }) {
  const [form, setForm] = useState(JSON.parse(JSON.stringify(cfg)))
  const [activeSection, setActiveSection] = useState('general')

  function save() { onSave(form); onClose(); showToast('✓ Configuration enregistrée') }

  function updSess(id, field, val) {
    setForm(f => ({ ...f, sessions: f.sessions.map(s => s.id === id ? { ...s, [field]: val } : s) }))
  }
  function addSess() {
    const colors = ['#1D9E75','#BA7517','#E24B4A','#7F77DD','#378ADD']
    const bgs = ['#E1F5EE','#FAEEDA','#FCEBEB','#EEEDFE','#E6F1FB']
    const i = form.sessions.length % 5
    setForm(f => ({ ...f, sessions: [...f.sessions, { id:'s'+Date.now(), label:'Nouvelle session', dur:15, price:20, deposit:5, color:colors[i], bg:bgs[i] }] }))
  }
  function rmSess(id) {
    if (form.sessions.length <= 1) { alert('Min 1 session.'); return }
    setForm(f => ({ ...f, sessions: f.sessions.filter(s => s.id !== id) }))
  }

  function addVacances() {
    setForm(f => ({ ...f, vacances: [...(f.vacances||[]), { start: todayStr(), end: todayStr(), label: 'Vacances' }] }))
  }
  function updVacances(i, field, val) {
    setForm(f => { const v = [...(f.vacances||[])]; v[i] = {...v[i],[field]:val}; return {...f,vacances:v} })
  }
  function rmVacances(i) {
    setForm(f => ({ ...f, vacances: (f.vacances||[]).filter((_,idx)=>idx!==i) }))
  }

  const sections = [
    { id:'general', label:'Général' },
    { id:'horaires', label:'Horaires' },
    { id:'sessions', label:'Sessions' },
    { id:'sms', label:'SMS / Brevo' },
  ]

  return (
    <div style={{ ...S.modal, width:'min(540px,96vw)' }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:14 }}>
        <h3 style={{ fontSize:15, fontWeight:700 }}>Configuration</h3>
        <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#9ca3af' }}>✕</button>
      </div>

      {/* Section tabs */}
      <div style={{ display:'flex', gap:2, background:'#f0f1f3', borderRadius:8, padding:3, marginBottom:16 }}>
        {sections.map(s => (
          <button key={s.id} style={S.tab(activeSection===s.id)} onClick={() => setActiveSection(s.id)}>{s.label}</button>
        ))}
      </div>

      {activeSection === 'general' && (
        <div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9 }}>
            <div style={S.field}><label style={S.fieldLabel}>Nom du karting</label><input style={S.input} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} /></div>
            <div style={S.field}><label style={S.fieldLabel}>Ville</label><input style={S.input} value={form.city} onChange={e=>setForm(f=>({...f,city:e.target.value}))} /></div>
            <div style={S.field}><label style={S.fieldLabel}>Karts adulte</label><input style={S.input} type="number" min={1} value={form.kart_adulte} onChange={e=>setForm(f=>({...f,kart_adulte:parseInt(e.target.value)}))} /></div>
            <div style={S.field}><label style={S.fieldLabel}>Karts enfant</label><input style={S.input} type="number" min={1} value={form.kart_enfant} onChange={e=>setForm(f=>({...f,kart_enfant:parseInt(e.target.value)}))} /></div>
          </div>
        </div>
      )}

      {activeSection === 'horaires' && (
        <div>
          <div style={{ fontSize:12, color:'#9ca3af', marginBottom:12, lineHeight:1.6 }}>
            Horaires fixes : Mer 14-22 · Jeu 16-22 · Ven 16-22 · Sam 14-22 · Dim 14-20<br />
            Vacances : tous les jours 14-22 · Lun/Mar exceptionnels : 14-20
          </div>

          <div style={{ fontSize:13, fontWeight:600, marginBottom:8 }}>Périodes de vacances</div>
          {(form.vacances||[]).map((v, i) => (
            <div key={i} style={{ display:'flex', gap:7, alignItems:'center', marginBottom:7, flexWrap:'wrap' }}>
              <input style={{ ...S.input, width:120 }} placeholder="Label" value={v.label} onChange={e=>updVacances(i,'label',e.target.value)} />
              <input style={{ ...S.input, width:130 }} type="date" value={v.start} onChange={e=>updVacances(i,'start',e.target.value)} />
              <span style={{ fontSize:11, color:'#9ca3af' }}>→</span>
              <input style={{ ...S.input, width:130 }} type="date" value={v.end} onChange={e=>updVacances(i,'end',e.target.value)} />
              <button style={S.btn('danger')} onClick={()=>rmVacances(i)}>✕</button>
            </div>
          ))}
          <button style={S.btn()} onClick={addVacances}>+ Ajouter période</button>

          <div style={{ fontSize:13, fontWeight:600, marginTop:16, marginBottom:8 }}>Jours exceptionnels (Lun/Mar)</div>
          <div style={{ fontSize:11, color:'#9ca3af', marginBottom:8 }}>Ajoutez manuellement les lundis et mardis exceptionnellement ouverts.</div>
          {(form.jours_exceptionnels||[]).map((j, i) => (
            <div key={i} style={{ display:'flex', gap:7, alignItems:'center', marginBottom:7, flexWrap:'wrap' }}>
              <input style={{ ...S.input, width:140 }} type="date" value={j.date}
                onChange={e=>setForm(f=>{const je=[...(f.jours_exceptionnels||[])];je[i]={...je[i],date:e.target.value};return{...f,jours_exceptionnels:je}})} />
              <span style={{ fontSize:11 }}>14h-</span>
              <input style={{ ...S.input, width:60 }} type="number" min={14} max={23} value={j.close}
                onChange={e=>setForm(f=>{const je=[...(f.jours_exceptionnels||[])];je[i]={...je[i],open:14,close:+e.target.value};return{...f,jours_exceptionnels:je}})} />
              <button style={S.btn('danger')}
                onClick={()=>setForm(f=>({...f,jours_exceptionnels:(f.jours_exceptionnels||[]).filter((_,idx)=>idx!==i)}))}>✕</button>
            </div>
          ))}
          <button style={S.btn()} onClick={()=>setForm(f=>({...f,jours_exceptionnels:[...(f.jours_exceptionnels||[]),{date:todayStr(),open:14,close:20}]}))}>+ Ajouter jour</button>
        </div>
      )}

      {activeSection === 'sessions' && (
        <div>
          <div style={{ display:'grid', gridTemplateColumns:'20px 1fr 50px 50px 56px 64px 20px', gap:5, marginBottom:5, fontSize:10, color:'#9ca3af' }}>
            <div/><div>Nom</div><div>Durée</div><div>Prix</div><div>Acompte</div><div>Couleurs</div><div/>
          </div>
          {form.sessions.map(s => (
            <div key={s.id} style={{ display:'grid', gridTemplateColumns:'20px 1fr 50px 50px 56px 64px 20px', gap:5, marginBottom:5, alignItems:'center' }}>
              <input type="color" value={s.color} onChange={e=>updSess(s.id,'color',e.target.value)} style={{ width:18, height:18, border:'none', cursor:'pointer', borderRadius:3, padding:0 }} />
              <input style={{ ...S.input, fontSize:12, padding:'4px 7px' }} value={s.label} onChange={e=>updSess(s.id,'label',e.target.value)} />
              <input style={{ ...S.input, fontSize:12, padding:'4px 7px' }} type="number" value={s.dur} onChange={e=>updSess(s.id,'dur',+e.target.value)} />
              <input style={{ ...S.input, fontSize:12, padding:'4px 7px' }} type="number" value={s.price} onChange={e=>updSess(s.id,'price',+e.target.value)} />
              <input style={{ ...S.input, fontSize:12, padding:'4px 7px' }} type="number" value={s.deposit} onChange={e=>updSess(s.id,'deposit',+e.target.value)} />
              <input type="color" value={s.bg} onChange={e=>updSess(s.id,'bg',e.target.value)} style={{ width:58, height:18, border:'none', cursor:'pointer', borderRadius:3, padding:0 }} />
              <button onClick={()=>rmSess(s.id)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af', fontSize:14 }}>✕</button>
            </div>
          ))}
          <button onClick={addSess} style={{ background:'none', border:'1px dashed #e5e7eb', borderRadius:7, padding:'7px', width:'100%', fontSize:12, color:'#9ca3af', cursor:'pointer', marginTop:4 }}>+ Ajouter une session</button>
        </div>
      )}

      {activeSection === 'sms' && (
        <div>
          <div style={S.field}>
            <label style={S.fieldLabel}>Clé API Brevo</label>
            <input style={S.input} type="password" value={form.brevo_api_key||''} onChange={e=>setForm(f=>({...f,brevo_api_key:e.target.value}))} placeholder="xkeysib-..." />
            <div style={{ fontSize:11, color:'#9ca3af', marginTop:4 }}>Obtenez votre clé sur app.brevo.com → SMTP & API</div>
          </div>
          <div style={S.field}>
            <label style={S.fieldLabel}>Template SMS</label>
            <div style={{ fontSize:11, color:'#9ca3af', marginBottom:5 }}>Variables : {'{nom} {karting} {date} {heure} {session} {duree} {participants} {total} {acompte} {lien}'}</div>
            <textarea style={{ ...S.input, height:90, resize:'vertical' }} value={form.sms} onChange={e=>setForm(f=>({...f,sms:e.target.value}))} />
          </div>
        </div>
      )}

      <div style={{ display:'flex', gap:6, justifyContent:'flex-end', marginTop:16, paddingTop:12, borderTop:'1px solid #f3f4f6' }}>
        <button style={S.btn()} onClick={()=>{ if(window.confirm('Réinitialiser la config ?')) setForm(JSON.parse(JSON.stringify(DEFAULT_CFG))) }}>Réinitialiser</button>
        <button style={S.btn('primary')} onClick={save}>Enregistrer</button>
      </div>
    </div>
  )
}
