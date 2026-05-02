import { useState, useEffect, useRef } from 'react'
import { supabase } from './supabase'

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const DAYS = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim']
const MONTHS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre']
const MS = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc']

// Horaires par jour (index 0=Lun ... 6=Dim), null = fermé
const HORAIRES_BASE = {
  0: null,       // Lundi — fermé (exceptionnel possible)
  1: null,       // Mardi — fermé (exceptionnel possible)
  2: [14, 22],   // Mercredi
  3: [16, 22],   // Jeudi
  4: [16, 22],   // Vendredi
  5: [14, 22],   // Samedi
  6: [14, 20],   // Dimanche
}
const HORAIRES_VACANCES = [14, 22]
const ENFANT_MAX_HOUR = 18  // sessions enfant interdites à partir de 18h

// Pauses automatiques — heures piles + fixes
function isPause(time) {
  if (time === '19:00') return '⛽ Essence'
  if (time === '20:00') return '🍽️ Miam'
  if (time.endsWith(':00')) return '⏸ Pause'
  return null
}

// Alternance adulte/enfant : de l'ouverture à 18h, on alterne A/E toutes les 15min
// Après 18h : adulte uniquement
function getSlotType(time, openHour) {
  const [h, m] = time.split(':').map(Number)
  if (h >= ENFANT_MAX_HOUR) return 'adulte'
  const totalMin = (h - openHour) * 60 + m
  const idx = totalMin / 15
  return idx % 2 === 0 ? 'adulte' : 'enfant'
}

const DEFAULT_CFG = {
  name: 'Green Kart', city: 'Échirolles',
  kart_adulte: 15, kart_enfant: 12,
  brevo_api_key: '',
  sms: 'Bonjour {nom} ! Réservation confirmée au {karting}.\n{date} à {heure} · {session} · {participants} pers.\nAcompte {acompte}€ : {lien}',
  sessions: [
    { id:'s1', label:'ADULTES', price:25, deposit:8, color:'#1D9E75', bg:'#E1F5EE' },
    { id:'s2', label:'ENFANTS', price:18, deposit:6, color:'#BA7517', bg:'#FAEEDA' },
  ],
  vacances: [],
  jours_exceptionnels: [],
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
  return Array.from({ length: 7 }, (_, i) => {
    const dd = new Date(ws); dd.setDate(ws.getDate() + i); return dd
  })
}

function isVacances(dateStr, vacances = []) {
  return vacances.some(v => dateStr >= v.start && dateStr <= v.end)
}

function getHoraires(dateStr, cfg) {
  const exc = (cfg.jours_exceptionnels || []).find(j => j.date === dateStr)
  if (exc) return [exc.open, exc.close]
  if (isVacances(dateStr, cfg.vacances)) return HORAIRES_VACANCES
  const d = new Date(dateStr + 'T12:00:00')
  const dow = d.getDay()
  const idx = dow === 0 ? 6 : dow - 1
  return HORAIRES_BASE[idx] || null
}

// Tous les créneaux toutes les 15min
function getAllSlots(open, close) {
  const s = []
  for (let h = open; h < close; h++)
    for (let m = 0; m < 60; m += 15)
      s.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`)
  return s
}

// Générer N créneaux à partir de startTime, en sautant les pauses
function generateSlots(startTime, n, allSlots) {
  const result = []
  let idx = allSlots.indexOf(startTime)
  if (idx < 0) return result
  while (result.length < n && idx < allSlots.length) {
    if (!isPause(allSlots[idx])) result.push(allSlots[idx])
    if (result.length < n) idx++
    else break
    // avancer jusqu'au prochain non-pause
    while (idx < allSlots.length && isPause(allSlots[idx])) idx++
  }
  return result
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  app: { fontFamily:'"DM Sans",-apple-system,BlinkMacSystemFont,sans-serif', color:'#1a1a1a', background:'#f7f8fa', minHeight:'100vh', padding:'0 16px 60px' },
  topbar: { display:'flex', alignItems:'center', gap:8, padding:'12px 0 10px', borderBottom:'1px solid #e5e7eb', flexWrap:'wrap' },
  brand: { fontSize:15, fontWeight:700, color:'#111', letterSpacing:'-0.3px' },
  tabs: { display:'flex', gap:2, background:'#f0f1f3', borderRadius:8, padding:3 },
  tab: (a) => ({ padding:'5px 13px', fontSize:12, border:'none', background:a?'#fff':'none', cursor:'pointer', borderRadius:6, fontWeight:a?600:400, color:a?'#111':'#6b7280', boxShadow:a?'0 1px 3px rgba(0,0,0,0.1)':'none', transition:'all 0.15s' }),
  btn: (v='default') => ({ background:v==='primary'?'#1D9E75':v==='danger'?'none':'#fff', border:v==='primary'?'none':v==='danger'?'1px solid #fca5a5':'1px solid #e5e7eb', borderRadius:7, padding:'5px 12px', fontSize:12, cursor:'pointer', color:v==='primary'?'#fff':v==='danger'?'#dc2626':'#374151', fontWeight:v==='primary'?600:400, transition:'all 0.15s' }),
  cap: { background:'#fff', borderRadius:9, padding:'7px 14px', border:'1px solid #e5e7eb' },
  capLabel: { fontSize:11, color:'#9ca3af', marginBottom:2 },
  capVal: { fontSize:15, fontWeight:700 },
  field: { marginBottom:11 },
  lbl: { display:'block', fontSize:10, color:'#9ca3af', marginBottom:3, textTransform:'uppercase', letterSpacing:'0.5px', fontWeight:600 },
  input: { width:'100%', border:'1px solid #e5e7eb', borderRadius:7, padding:'7px 10px', fontSize:13, fontFamily:'inherit', outline:'none', background:'#fff' },
  modal: { background:'#fff', border:'1px solid #e5e7eb', borderRadius:14, padding:22, width:'min(480px,96vw)', maxHeight:'92vh', overflowY:'auto', boxShadow:'0 24px 64px rgba(0,0,0,0.14)', animation:'fadeIn 0.15s ease' },
  overlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.35)', display:'flex', alignItems:'flex-start', justifyContent:'center', zIndex:1000, paddingTop:30, backdropFilter:'blur(3px)' },
  badge: (bg,c) => ({ display:'inline-block', fontSize:10, padding:'2px 7px', borderRadius:20, fontWeight:600, background:bg, color:c }),
  row: { display:'flex', alignItems:'center', gap:8, padding:'9px 11px', border:'1px solid #e5e7eb', borderRadius:9, marginBottom:5, background:'#fff' },
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
    const { data } = await supabase.from('reservations').select('*')
    if (data) setReservations(data)
    setLoading(false)
  }

  function saveCfg(c) { setCfg(c); try { localStorage.setItem('gk_cfg', JSON.stringify(c)) } catch {} }

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

  // ─── CRUD ─────────────────────────────────────────────────────────────────
  async function saveReservation(items) {
    // items = [{ dateStr, time, name, phone, email, session, participants, kart_type, notes }]
    for (const item of items) {
      const id = Date.now().toString(36) + Math.random().toString(36).substr(2,5)
      const { error } = await supabase.from('reservations').insert({
        id, date: item.dateStr, time: item.time,
        name: item.name, phone: item.phone, email: item.email || null,
        session: item.session, participants: item.participants,
        kart_type: item.kart_type, notes: item.notes || null,
        deposit_link: `https://pay.greenkart.fr/${id}`,
        arrived: false, acompte_paid: false,
      })
      if (error) { showToast('❌ Erreur : ' + error.message, 'err'); return false }
    }
    setModal(null)
    showToast(`✓ ${items.length > 1 ? items.length + ' réservations créées' : 'Réservation confirmée'}`)
    return true
  }

  async function toggleArrived(id) {
    const r = reservations.find(x => x.id === id)
    if (!r) return
    const linked = reservations.filter(x => x.name === r.name && x.phone === r.phone && x.date === r.date)
    const newVal = !r.arrived
    for (const lr of linked) await supabase.from('reservations').update({ arrived: newVal }).eq('id', lr.id)
    showToast(newVal ? `✓ ${r.name} arrivé${linked.length > 1 ? ` (${linked.length} sessions)` : ''}` : `${r.name} en attente`)
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
    if (error) showToast('❌ ' + error.message, 'err')
    else showToast('✓ Mis à jour')
  }

  function getResAt(ds, time) { return reservations.filter(r => r.date === ds && r.time === time) }
  function getUsed(ds, time, kt) { return reservations.filter(r => r.date === ds && r.time === time && r.kart_type === kt).reduce((s,r) => s + (r.participants||1), 0) }
  function getRemaining(ds, time, kt) { return (kt==='adulte'?cfg.kart_adulte:cfg.kart_enfant) - getUsed(ds,time,kt) }

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', minHeight:'100vh', flexDirection:'column', gap:16 }}>
      <div style={{ width:32, height:32, border:'3px solid #e5e7eb', borderTop:'3px solid #1D9E75', borderRadius:'50%', animation:'spin 1s linear infinite' }} />
      <div style={{ fontSize:13, color:'#9ca3af' }}>Chargement...</div>
    </div>
  )

  return (
    <div style={S.app}>
      {toast && (
        <div style={{ position:'fixed', top:16, right:16, zIndex:2000, background:'#fff', border:'1px solid #e5e7eb', borderLeft:`3px solid ${toast.type==='err'?'#dc2626':'#1D9E75'}`, borderRadius:9, padding:'10px 14px', fontSize:13, boxShadow:'0 4px 20px rgba(0,0,0,0.1)', animation:'fadeIn 0.2s ease', maxWidth:320 }}>
          {toast.msg}
        </div>
      )}

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

      <div style={{ display:'flex', gap:8, marginTop:8, flexWrap:'wrap' }}>
        <div style={S.cap}><div style={S.capLabel}>Karts adulte</div><div style={{ ...S.capVal, color:'#1D9E75' }}>{cfg.kart_adulte} max</div></div>
        <div style={S.cap}><div style={S.capLabel}>Karts enfant</div><div style={{ ...S.capVal, color:'#BA7517' }}>{cfg.kart_enfant} max</div></div>
        <div style={{ ...S.cap, marginLeft:'auto' }}><div style={S.capLabel}>Réservations</div><div style={S.capVal}>{reservations.length}</div></div>
      </div>
      <div style={{ display:'flex', gap:10, padding:'6px 0', borderBottom:'1px solid #e5e7eb', flexWrap:'wrap', fontSize:11, color:'#6b7280', marginTop:6 }}>
        {cfg.sessions.map(s => <span key={s.id}><span style={{ display:'inline-block', width:8, height:8, borderRadius:2, background:s.color, marginRight:4 }} />{s.label} {s.price}€</span>)}
        <span style={{ color:'#d1d5db' }}>|</span>
        <span>⏸ Heures piles = pause</span>
        <span>🟢 Adulte · 🟡 Enfant (14h→18h)</span>
      </div>

      {tab === 'cal' && <CalView days={days} view={view} cfg={cfg} reservations={reservations} ts={ts} setCurDate={setCurDate} setView={setView} setModal={setModal} getResAt={getResAt} getRemaining={getRemaining} />}
      {tab === 'today' && <TodayPage cfg={cfg} reservations={reservations} toggleArrived={toggleArrived} toggleAcompte={toggleAcompte} setModal={setModal} showToast={showToast} />}
      {tab === 'events' && <EventsPage cfg={cfg} reservations={reservations} saveReservation={saveReservation} showToast={showToast} />}

      {modal && (
        <div style={S.overlay} onClick={() => setModal(null)}>
          <div onClick={e => e.stopPropagation()}>
            {modal.type === 'new' && <NewResModal cfg={cfg} dateStr={modal.dateStr} time={modal.time} reservations={reservations} onSave={saveReservation} onClose={() => setModal(null)} />}
            {modal.type === 'detail' && <DetailModal cfg={cfg} res={modal.res} onToggleArrived={toggleArrived} onToggleAcompte={toggleAcompte} onDelete={deleteRes} onUpdate={updateRes} onClose={() => setModal(null)} showToast={showToast} />}
            {modal.type === 'config' && <ConfigModal cfg={cfg} onSave={saveCfg} onClose={() => setModal(null)} showToast={showToast} />}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── CAL VIEW ─────────────────────────────────────────────────────────────────
function CalView({ days, view, cfg, reservations, ts, setCurDate, setView, setModal, getResAt, getRemaining }) {
  const slotsPerDay = days.map(d => {
    const ds = fmtDate(d)
    const h = getHoraires(ds, cfg)
    return h ? getAllSlots(h[0], h[1]) : []
  })
  const allTimes = [...new Set(slotsPerDay.flat())].sort()

  return (
    <div style={{ overflowX:'auto', marginTop:0 }}>
      <div style={{ display:'grid', gridTemplateColumns:`52px repeat(${days.length}, minmax(${view==='jour'?'440px':'100px'}, 1fr))`, minWidth:view==='jour'?492:740 }}>
        <div style={{ borderBottom:'1px solid #e5e7eb', position:'sticky', top:0, background:'#f7f8fa', zIndex:10 }} />
        {days.map((d, i) => {
          const ds = fmtDate(d), isT = ds === ts
          const h = getHoraires(ds, cfg)
          const totalRes = reservations.filter(r => r.date === ds).length
          return (
            <div key={i} onClick={() => { if(view==='semaine'){setCurDate(new Date(ds+'T12:00:00'));setView('jour')} }}
              style={{ fontSize:11, color:isT?'#1D9E75':'#9ca3af', padding:'7px 3px 5px', textAlign:'center', borderBottom:'1px solid #e5e7eb', borderLeft:'1px solid #f0f1f3', position:'sticky', top:0, background:'#f7f8fa', zIndex:10, cursor:'pointer' }}>
              <div>{DAYS[i % 7]}</div>
              <div style={{ fontSize:18, fontWeight:700, color:isT?'#1D9E75':h?'#111':'#d1d5db', lineHeight:1.1 }}>{d.getDate()}</div>
              {isVacances(ds, cfg.vacances) && <div style={{ fontSize:8, color:'#7F77DD', fontWeight:700 }}>VAC</div>}
              {!h && !isVacances(ds, cfg.vacances) && <div style={{ fontSize:8, color:'#d1d5db' }}>fermé</div>}
              {totalRes > 0 && <div style={{ fontSize:9, color:'#1D9E75', fontWeight:600 }}>{totalRes} résa</div>}
            </div>
          )
        })}

        {allTimes.map(time => {
          const isH = time.endsWith(':00')
          const pause = isPause(time)
          return [
            <div key={`t-${time}`} style={{ fontSize:10, color:isH?'#9ca3af':'transparent', textAlign:'right', paddingRight:5, display:'flex', alignItems:'flex-start', justifyContent:'flex-end', paddingTop:2, borderBottom:`1px solid ${isH?'#e5e7eb':'#f3f4f6'}`, height:38 }}>{time}</div>,
            ...days.map((day, di) => {
              const ds = fmtDate(day)
              const inRange = slotsPerDay[di].includes(time)
              const sr = getResAt(ds, time)
              const h = getHoraires(ds, cfg)
              const slotType = h ? getSlotType(time, h[0]) : 'adulte'
              const remA = getRemaining(ds, time, 'adulte')
              const remE = getRemaining(ds, time, 'enfant')
              const isEnfant = slotType === 'enfant'

              return (
                <div key={`s-${time}-${di}`}
                  onClick={() => inRange && !pause && setModal({ type:'new', dateStr:ds, time })}
                  style={{ height:38, borderBottom:`1px solid ${isH?'#e5e7eb':'#f3f4f6'}`, borderLeft:'1px solid #f0f1f3', background:!inRange?'#fafafa':pause?'#FFFBEB':isEnfant?'#fffef5':'#fff', position:'relative', cursor:(!inRange||pause)?'default':'pointer' }}
                  onMouseEnter={e => { if(inRange&&!pause) e.currentTarget.style.background='#f0faf5' }}
                  onMouseLeave={e => { e.currentTarget.style.background = !inRange?'#fafafa':pause?'#FFFBEB':isEnfant?'#fffef5':'#fff' }}
                >
                  {!inRange && <div style={{ position:'absolute', inset:0, background:'repeating-linear-gradient(45deg,transparent,transparent 4px,#f3f4f6 4px,#f3f4f6 5px)' }} />}
                  {pause && inRange && (
                    <div style={{ position:'absolute', inset:'2px 2px', borderRadius:3, background:'#FEF3C7', display:'flex', alignItems:'center', padding:'0 6px', fontSize:9, fontWeight:700, color:'#92400E' }}>{pause}</div>
                  )}
                  {!pause && inRange && (
                    <>
                      {sr.map((r, ri) => {
                        const s = cfg.sessions.find(x => x.id === r.session)
                        const w = 100 / Math.max(sr.length, 1)
                        return (
                          <div key={r.id} onClick={e => { e.stopPropagation(); setModal({ type:'detail', res:r }) }}
                            style={{ position:'absolute', top:2, bottom:2, left:`${ri*w}%`, width:`calc(${w}% - 3px)`, background:s?s.bg:'#f3f4f6', border:`1px solid ${s?s.color:'#e5e7eb'}`, borderRadius:3, padding:'0 4px', fontSize:9, fontWeight:600, color:s?s.color:'#374151', overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis', display:'flex', alignItems:'center', gap:2, cursor:'pointer', opacity:r.arrived?0.5:1 }}>
                            {r.arrived?'✓ ':''}{r.name}·{r.participants}p
                          </div>
                        )
                      })}
                      {/* Places restantes toujours visibles */}
                      <div style={{ position:'absolute', bottom:1, right:2, display:'flex', gap:2, pointerEvents:'none' }}>
                        <span style={{ fontSize:8, background:'#E1F5EE', color:'#0F6E56', padding:'1px 4px', borderRadius:3, fontWeight:700, opacity:0.9 }}>A:{remA}</span>
                        {isEnfant && <span style={{ fontSize:8, background:'#FAEEDA', color:'#854F0B', padding:'1px 4px', borderRadius:3, fontWeight:700, opacity:0.9 }}>E:{remE}</span>}
                      </div>
                    </>
                  )}
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
  const h = getHoraires(ts, cfg)
  const allSlots = h ? getAllSlots(h[0], h[1]) : []
  const todayRes = reservations.filter(r => r.date === ts)
  const arrived = todayRes.filter(r => r.arrived).length

  const allTimes = [...new Set([...allSlots, ...todayRes.map(r => r.time)])].sort()

  return (
    <div style={{ paddingTop:14 }}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:14, flexWrap:'wrap', gap:8 }}>
        <div>
          <div style={{ fontSize:16, fontWeight:700 }}>Aujourd'hui</div>
          <div style={{ fontSize:12, color:'#9ca3af' }}>{new Date().toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</div>
          {!h && <div style={{ fontSize:11, color:'#dc2626', marginTop:2 }}>⚠️ Journée non programmée</div>}
        </div>
        <div style={{ display:'flex', gap:7 }}>
          {[['Total',todayRes.length,'#111'],['Arrivés',arrived,'#1D9E75'],['En attente',todayRes.length-arrived,'#374151']].map(([l,v,c]) => (
            <div key={l} style={{ background:'#fff', border:'1px solid #e5e7eb', borderRadius:9, padding:'6px 12px', textAlign:'center' }}>
              <div style={{ fontSize:17, fontWeight:700, color:c }}>{v}</div>
              <div style={{ fontSize:11, color:'#9ca3af' }}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {allTimes.map(time => {
        const pause = h && allSlots.includes(time) ? isPause(time) : null
        const inRange = allSlots.includes(time)
        const slotRes = todayRes.filter(r => r.time === time)
        const slotType = h ? getSlotType(time, h[0]) : 'adulte'

        return (
          <div key={time} style={{ marginBottom:8 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', border:`1px solid ${pause?'#FCD34D':slotType==='enfant'&&inRange?'#F5E6CC':'#e5e7eb'}`, borderRadius:8, marginBottom:3, background:pause?'#FFFBEB':slotType==='enfant'&&inRange&&!pause?'#FFFDF5':'#f9fafb' }}>
              <span style={{ fontSize:13, fontWeight:700, minWidth:44, color:pause?'#92400E':'#6b7280' }}>{time}</span>
              {pause && <span style={{ fontSize:11, fontWeight:700, color:'#92400E' }}>{pause} — pause</span>}
              {!pause && inRange && (
                <span style={{ fontSize:10, padding:'2px 8px', borderRadius:20, background:slotType==='adulte'?'#E1F5EE':'#FAEEDA', color:slotType==='adulte'?'#0F6E56':'#854F0B', fontWeight:600 }}>
                  {slotType === 'adulte' ? '🟢 Adulte' : '🟡 Enfant'}
                </span>
              )}
              {!inRange && <span style={{ fontSize:10, color:'#9ca3af', fontStyle:'italic' }}>hors horaires</span>}
              {!pause && inRange && <button style={{ ...S.btn('primary'), marginLeft:'auto' }} onClick={() => setModal({ type:'new', dateStr:ts, time })}>+ Résa</button>}
            </div>

            {slotRes.map(r => {
              const s = cfg.sessions.find(x => x.id === r.session)
              return (
                <div key={r.id} style={{ ...S.row, marginLeft:16 }}>
                  <div onClick={() => toggleArrived(r.id)} style={{ width:22, height:22, borderRadius:'50%', border:`1.5px solid ${r.arrived?'#1D9E75':'#d1d5db'}`, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, background:r.arrived?'#1D9E75':'none', color:r.arrived?'#fff':'transparent', flexShrink:0 }}>✓</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:600, textDecoration:r.arrived?'line-through':'none', color:r.arrived?'#9ca3af':'#111' }}>{r.name}</div>
                    <div style={{ fontSize:11, color:'#9ca3af', marginTop:1, display:'flex', gap:5, flexWrap:'wrap' }}>
                      <span style={S.badge(s?s.bg:'#f3f4f6', s?s.color:'#374151')}>{s?.label||'?'}</span>
                      <span style={S.badge(r.kart_type==='adulte'?'#E1F5EE':'#FAEEDA', r.kart_type==='adulte'?'#0F6E56':'#854F0B')}>{r.kart_type}</span>
                      {r.participants} pers · {r.phone}
                    </div>
                    {r.notes && <div style={{ fontSize:10, color:'#d1d5db', marginTop:1 }}>📝 {r.notes}</div>}
                  </div>
                  <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:5 }}>
                    <button onClick={() => toggleAcompte(r.id)} style={{ fontSize:11, padding:'3px 9px', borderRadius:20, border:`1px solid ${r.acompte_paid?'#1D9E75':'#e5e7eb'}`, cursor:'pointer', background:r.acompte_paid?'#E1F5EE':'none', color:r.acompte_paid?'#0F6E56':'#9ca3af', fontWeight:r.acompte_paid?600:400 }}>
                      {r.acompte_paid ? '✓ Acompte' : `Acompte ${s?.deposit||'?'}€`}
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

// ─── NEW RES MODAL ────────────────────────────────────────────────────────────
function NewResModal({ cfg, dateStr, time, reservations, onSave, onClose }) {
  const d = new Date(dateStr + 'T12:00:00')
  const h = getHoraires(dateStr, cfg)
  const allSlots = h ? getAllSlots(h[0], h[1]) : []

  const [form, setForm] = useState({
    name:'', phone:'', email:'', notes:'',
    adulteEnabled: true,  adulteNbSessions: 1, adulteParticipants: 1,
    enfantEnabled: false, enfantNbSessions: 1, enfantParticipants: 1,
  })

  const sAdulte = cfg.sessions.find(x => x.label?.toUpperCase().includes('ADULTE')) || cfg.sessions[0]
  const sEnfant = cfg.sessions.find(x => x.label?.toUpperCase().includes('ENFANT')) || cfg.sessions[1] || cfg.sessions[0]

  // Créneaux générés pour adulte et enfant
  const adulteSlots = form.adulteEnabled ? generateSlots(time, form.adulteNbSessions, allSlots) : []
  const enfantSlots = form.enfantEnabled
    ? generateSlots(time, form.enfantNbSessions, allSlots).filter(t => t < `${String(ENFANT_MAX_HOUR).padStart(2,'0')}:00`)
    : []

  // Tous les créneaux concernés (union triée)
  const previewSlots = [...new Set([...adulteSlots, ...enfantSlots])].sort()

  function getRemaining(t, kt) {
    const max = kt === 'adulte' ? cfg.kart_adulte : cfg.kart_enfant
    const used = reservations.filter(r => r.date === dateStr && r.time === t && r.kart_type === kt).reduce((s,r) => s + r.participants, 0)
    return max - used
  }

  function buildItems() {
    const items = []
    for (const t of adulteSlots) {
      items.push({ dateStr, time:t, name:form.name, phone:form.phone, email:form.email, session:sAdulte?.id, participants:form.adulteParticipants, kart_type:'adulte', notes:form.notes })
    }
    for (const t of enfantSlots) {
      items.push({ dateStr, time:t, name:form.name, phone:form.phone, email:form.email, session:sEnfant?.id, participants:form.enfantParticipants, kart_type:'enfant', notes:form.notes })
    }
    return items
  }

  function handleSave() {
    if (!form.name.trim() || !form.phone.trim()) { alert('Nom et téléphone obligatoires.'); return }
    if (!form.adulteEnabled && !form.enfantEnabled) { alert('Sélectionnez au moins un type.'); return }
    const items = buildItems()
    for (const item of items) {
      const rem = getRemaining(item.time, item.kart_type)
      if (item.participants > rem) { alert(`Plus assez de place ${item.kart_type} à ${item.time} (${rem} dispo)`); return }
    }
    onSave(items)
  }

  return (
    <div style={S.modal}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
        <h3 style={{ fontSize:15, fontWeight:700 }}>Nouvelle réservation</h3>
        <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#9ca3af' }}>✕</button>
      </div>
      <div style={{ fontSize:12, color:'#9ca3af', marginBottom:14 }}>
        {d.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})} à {time}
      </div>

      {/* Bloc Adulte */}
      <div style={{ border:`2px solid ${form.adulteEnabled?'#1D9E75':'#e5e7eb'}`, borderRadius:10, padding:'10px 12px', marginBottom:10, background:form.adulteEnabled?'#f0faf5':'#fafafa', transition:'all 0.15s' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:form.adulteEnabled?10:0 }}>
          <input type="checkbox" id="adulteOn" checked={form.adulteEnabled} onChange={e=>setForm(f=>({...f,adulteEnabled:e.target.checked}))} style={{ width:16, height:16, accentColor:'#1D9E75' }} />
          <label htmlFor="adulteOn" style={{ fontSize:13, fontWeight:700, color:'#1D9E75', cursor:'pointer' }}>🟢 Adulte</label>
          {sAdulte && <span style={{ fontSize:11, color:'#9ca3af', marginLeft:'auto' }}>{sAdulte.price}€/pers</span>}
        </div>
        {form.adulteEnabled && (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            <div><label style={S.lbl}>Nb de sessions</label>
              <input style={S.input} type="number" min={1} max={10} value={form.adulteNbSessions} onChange={e=>setForm(f=>({...f,adulteNbSessions:Math.max(1,parseInt(e.target.value)||1)}))} />
            </div>
            <div><label style={S.lbl}>Participants</label>
              <input style={S.input} type="number" min={1} max={cfg.kart_adulte} value={form.adulteParticipants} onChange={e=>setForm(f=>({...f,adulteParticipants:Math.max(1,parseInt(e.target.value)||1)}))} />
            </div>
          </div>
        )}
      </div>

      {/* Bloc Enfant */}
      <div style={{ border:`2px solid ${form.enfantEnabled?'#BA7517':'#e5e7eb'}`, borderRadius:10, padding:'10px 12px', marginBottom:14, background:form.enfantEnabled?'#fffbf0':'#fafafa', transition:'all 0.15s' }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:form.enfantEnabled?10:0 }}>
          <input type="checkbox" id="enfantOn" checked={form.enfantEnabled} onChange={e=>setForm(f=>({...f,enfantEnabled:e.target.checked}))} style={{ width:16, height:16, accentColor:'#BA7517' }} />
          <label htmlFor="enfantOn" style={{ fontSize:13, fontWeight:700, color:'#BA7517', cursor:'pointer' }}>🟡 Enfant <span style={{ fontSize:10, fontWeight:400, color:'#9ca3af' }}>(jusqu'à 18h)</span></label>
          {sEnfant && <span style={{ fontSize:11, color:'#9ca3af', marginLeft:'auto' }}>{sEnfant.price}€/pers</span>}
        </div>
        {form.enfantEnabled && (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            <div><label style={S.lbl}>Nb de sessions</label>
              <input style={S.input} type="number" min={1} max={10} value={form.enfantNbSessions} onChange={e=>setForm(f=>({...f,enfantNbSessions:Math.max(1,parseInt(e.target.value)||1)}))} />
            </div>
            <div><label style={S.lbl}>Participants</label>
              <input style={S.input} type="number" min={1} max={cfg.kart_enfant} value={form.enfantParticipants} onChange={e=>setForm(f=>({...f,enfantParticipants:Math.max(1,parseInt(e.target.value)||1)}))} />
            </div>
          </div>
        )}
      </div>

      {/* Aperçu planning */}
      {previewSlots.length > 0 && (
        <div style={{ background:'#f9fafb', borderRadius:9, padding:'10px 12px', marginBottom:14, border:'1px solid #e5e7eb' }}>
          <div style={{ fontSize:10, fontWeight:700, color:'#9ca3af', marginBottom:8, textTransform:'uppercase', letterSpacing:'0.5px' }}>📅 Aperçu dans le planning</div>
          {previewSlots.map(t => {
            const isA = adulteSlots.includes(t)
            const isE = enfantSlots.includes(t)
            const remA = getRemaining(t, 'adulte')
            const remE = getRemaining(t, 'enfant')
            const existing = reservations.filter(r => r.date === dateStr && r.time === t)
            const overA = isA && form.adulteParticipants > remA
            const overE = isE && form.enfantParticipants > remE
            return (
              <div key={t} style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, marginBottom:5, padding:'5px 8px', borderRadius:7, background:'#fff', border:`1px solid ${overA||overE?'#fca5a5':'#e5e7eb'}` }}>
                <span style={{ fontWeight:700, color:'#1D9E75', minWidth:42 }}>{t}</span>
                <div style={{ display:'flex', gap:4, flex:1, flexWrap:'wrap' }}>
                  {isA && <span style={S.badge(overA?'#FCEBEB':'#E1F5EE', overA?'#dc2626':'#0F6E56')}>A:{form.adulteParticipants}p · {remA} libre{overA?' ⚠️':''}</span>}
                  {isE && <span style={S.badge(overE?'#FCEBEB':'#FAEEDA', overE?'#dc2626':'#854F0B')}>E:{form.enfantParticipants}p · {remE} libre{overE?' ⚠️':''}</span>}
                  {existing.map(r => <span key={r.id} style={S.badge('#f3f4f6','#6b7280')}>{r.name}</span>)}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Client */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9 }}>
        <div style={S.field}><label style={S.lbl}>Nom *</label><input style={S.input} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="Jean Dupont" /></div>
        <div style={S.field}><label style={S.lbl}>Téléphone *</label><input style={S.input} value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} placeholder="+33 6 12 34 56 78" /></div>
        <div style={S.field}><label style={S.lbl}>Email</label><input style={S.input} type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="jean@email.fr" /></div>
      </div>
      <div style={S.field}><label style={S.lbl}>Notes</label><textarea style={{ ...S.input, height:48, resize:'vertical' }} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} /></div>

      <div style={{ display:'flex', gap:7, justifyContent:'flex-end' }}>
        <button style={S.btn()} onClick={onClose}>Annuler</button>
        <button style={S.btn('primary')} onClick={handleSave}>
          ✓ Confirmer {buildItems().length > 1 ? `(${buildItems().length} créneaux)` : ''}
        </button>
      </div>
    </div>
  )
}

// ─── EVENTS PAGE ──────────────────────────────────────────────────────────────
function EventsPage({ cfg, reservations, saveReservation, showToast }) {
  const [eventType, setEventType] = useState('trophee')
  const [form, setForm] = useState({ date:todayStr(), startTime:'14:00', name:'', phone:'', email:'', adulte:1, enfant:0, customSessions:[], notes:'' })

  const EVENT_DEFS = {
    trophee:  { label:'🏆 Trophée',   desc:'Chrono + Course (2 créneaux)', sessions:[{label:'Chrono'},{label:'Course'}] },
    challenge:{ label:'⚡ Challenge',  desc:'Essai + Chrono + Course (3 créneaux)', sessions:[{label:'Essai'},{label:'Chrono'},{label:'Course'}] },
    custom:   { label:'✏️ Sur mesure', desc:'Configurez vos sessions', sessions:form.customSessions },
  }

  const sessions = eventType === 'custom' ? form.customSessions : EVENT_DEFS[eventType].sessions

  // Calcul des créneaux : 1 session = 1 créneau de 15min, avec pause auto si heure pile
  function computeEventSlots() {
    const h = getHoraires(form.date, cfg)
    if (!h) return []
    const all = getAllSlots(h[0], h[1])
    // Trouver le startTime dans la liste (ou le plus proche)
    let idx = all.indexOf(form.startTime)
    if (idx < 0) return []
    const result = []
    for (const s of sessions) {
      // Sauter les pauses
      while (idx < all.length && isPause(all[idx])) idx++
      if (idx >= all.length) break
      result.push({ ...s, time: all[idx] })
      idx++ // créneau suivant (+15min)
      // Sauter la pause entre chaque session (si l'heure suivante est une pause)
      while (idx < all.length && isPause(all[idx])) idx++
    }
    return result
  }

  const eventSlots = computeEventSlots()
  const existingRes = reservations.filter(r => r.date === form.date)

  async function handleCreate() {
    if (!form.name.trim() || !form.phone.trim()) { alert('Nom et téléphone obligatoires.'); return }
    if (sessions.length === 0) { alert('Ajoutez au moins une session.'); return }
    if (!parseInt(form.adulte) && !parseInt(form.enfant)) { alert('Ajoutez des participants.'); return }

    const items = []
    for (const slot of eventSlots) {
      if (parseInt(form.adulte) > 0) items.push({ dateStr:form.date, time:slot.time, name:form.name, phone:form.phone, email:form.email, session:cfg.sessions[0]?.id, participants:parseInt(form.adulte), kart_type:'adulte', notes:`${EVENT_DEFS[eventType].label} · ${slot.label}${form.notes?' · '+form.notes:''}` })
      if (parseInt(form.enfant) > 0 && slot.time < `${String(ENFANT_MAX_HOUR).padStart(2,'0')}:00`) items.push({ dateStr:form.date, time:slot.time, name:form.name, phone:form.phone, email:form.email, session:cfg.sessions[1]?.id||cfg.sessions[0]?.id, participants:parseInt(form.enfant), kart_type:'enfant', notes:`${EVENT_DEFS[eventType].label} · ${slot.label}${form.notes?' · '+form.notes:''}` })
    }

    const ok = await saveReservation(items)
    if (ok) setForm(f => ({ ...f, name:'', phone:'', email:'', notes:'', adulte:1, enfant:0 }))
  }

  return (
    <div style={{ paddingTop:14, maxWidth:580 }}>
      <div style={{ fontSize:15, fontWeight:700, marginBottom:3 }}>Créer un événement</div>
      <div style={{ fontSize:12, color:'#9ca3af', marginBottom:14 }}>Créneaux toutes les 15min · Pauses auto aux heures piles · Inscrit directement dans le planning</div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:7, marginBottom:14 }}>
        {Object.entries(EVENT_DEFS).map(([k, et]) => (
          <div key={k} onClick={() => setEventType(k)}
            style={{ border:`${eventType===k?'2px':'1px'} solid ${eventType===k?'#1D9E75':'#e5e7eb'}`, borderRadius:9, padding:'10px 12px', cursor:'pointer', background:eventType===k?'#E1F5EE':'#fff' }}>
            <div style={{ fontSize:13, fontWeight:700, color:eventType===k?'#1D9E75':'#111' }}>{et.label}</div>
            <div style={{ fontSize:10, color:'#9ca3af', marginTop:3, lineHeight:1.4 }}>{et.desc}</div>
          </div>
        ))}
      </div>

      {eventType === 'custom' && (
        <div style={{ marginBottom:12 }}>
          {form.customSessions.map((cs, i) => (
            <div key={i} style={{ display:'flex', gap:6, alignItems:'center', marginBottom:6 }}>
              <input style={{ ...S.input, flex:1 }} placeholder="Nom de la session" value={cs.label} onChange={e=>setForm(f=>{const cs=[...f.customSessions];cs[i]={...cs[i],label:e.target.value};return{...f,customSessions:cs}})} />
              <button style={S.btn('danger')} onClick={()=>setForm(f=>({...f,customSessions:f.customSessions.filter((_,idx)=>idx!==i)}))}>✕</button>
            </div>
          ))}
          <button style={S.btn()} onClick={()=>setForm(f=>({...f,customSessions:[...f.customSessions,{label:'Session'}]}))}>+ Session</button>
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9, marginBottom:9 }}>
        <div style={S.field}><label style={S.lbl}>Date</label><input style={S.input} type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} /></div>
        <div style={S.field}><label style={S.lbl}>Heure de début</label><input style={S.input} type="time" value={form.startTime} onChange={e=>setForm(f=>({...f,startTime:e.target.value}))} /></div>
      </div>

      {/* Aperçu créneaux */}
      {eventSlots.length > 0 && (
        <div style={{ background:'#f9fafb', borderRadius:9, padding:'10px 12px', marginBottom:12, border:'1px solid #e5e7eb' }}>
          <div style={{ fontSize:10, fontWeight:700, color:'#9ca3af', marginBottom:8, textTransform:'uppercase' }}>📅 Créneaux dans le planning</div>
          {eventSlots.map((s, i) => {
            const existing = existingRes.filter(r => r.time === s.time)
            return (
              <div key={i} style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, marginBottom:4, padding:'5px 8px', borderRadius:7, background:'#fff', border:'1px solid #e5e7eb' }}>
                <span style={{ fontWeight:700, color:'#1D9E75', minWidth:42 }}>{s.time}</span>
                <span style={{ fontWeight:600 }}>{s.label}</span>
                {existing.map(r => <span key={r.id} style={S.badge('#f3f4f6','#6b7280')}>{r.name}</span>)}
                {existing.length > 0 && <span style={{ fontSize:10, color:'#EA580C' }}>⚠️ occupé</span>}
              </div>
            )
          })}
        </div>
      )}

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:9, marginBottom:9 }}>
        <div style={S.field}><label style={S.lbl}>Nom *</label><input style={S.input} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="Jean Dupont" /></div>
        <div style={S.field}><label style={S.lbl}>🟢 Adultes</label><input style={S.input} type="number" min={0} value={form.adulte} onChange={e=>setForm(f=>({...f,adulte:e.target.value}))} /></div>
        <div style={S.field}><label style={S.lbl}>🟡 Enfants</label><input style={S.input} type="number" min={0} value={form.enfant} onChange={e=>setForm(f=>({...f,enfant:e.target.value}))} /></div>
        <div style={S.field}><label style={S.lbl}>Téléphone *</label><input style={S.input} value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} placeholder="+33 6..." /></div>
        <div style={S.field}><label style={S.lbl}>Email</label><input style={S.input} type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} /></div>
      </div>
      <div style={S.field}><label style={S.lbl}>Notes</label><textarea style={{ ...S.input, height:44, resize:'vertical' }} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} /></div>

      <button style={{ ...S.btn('primary'), padding:'10px 24px', fontSize:13, width:'100%' }} onClick={handleCreate}>
        🏁 Créer et inscrire dans le planning ({eventSlots.length} créneaux)
      </button>
    </div>
  )
}

// ─── DETAIL MODAL ─────────────────────────────────────────────────────────────
function DetailModal({ cfg, res, onToggleArrived, onToggleAcompte, onDelete, onUpdate, onClose, showToast }) {
  const s = cfg.sessions.find(x => x.id === res.session)
  const d = new Date(res.date + 'T12:00:00')
  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({ participants:res.participants, date:res.date, time:res.time, notes:res.notes||'' })

  async function handleUpdate() {
    await onUpdate(res.id, { participants:parseInt(editForm.participants), date:editForm.date, time:editForm.time, notes:editForm.notes })
    setEditing(false)
  }

  return (
    <div style={S.modal}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
        <h3 style={{ fontSize:15, fontWeight:700 }}>{res.name}</h3>
        <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#9ca3af' }}>✕</button>
      </div>
      <div style={{ fontSize:12, color:'#9ca3af', marginBottom:12 }}>{d.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})} à {res.time}</div>
      <div style={{ display:'flex', gap:6, marginBottom:13, flexWrap:'wrap' }}>
        <span style={{ fontSize:12, padding:'4px 10px', borderRadius:20, background:res.arrived?'#E1F5EE':'#f3f4f6', color:res.arrived?'#0F6E56':'#6b7280' }}>{res.arrived?'✓ Arrivé':'En attente'}</span>
        <span style={{ fontSize:12, padding:'4px 10px', borderRadius:20, background:res.acompte_paid?'#E1F5EE':'#f3f4f6', color:res.acompte_paid?'#0F6E56':'#6b7280' }}>💳 {res.acompte_paid?'Acompte reçu':'Acompte en attente'}</span>
      </div>

      {editing ? (
        <div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9 }}>
            <div style={S.field}><label style={S.lbl}>Date</label><input style={S.input} type="date" value={editForm.date} onChange={e=>setEditForm(f=>({...f,date:e.target.value}))} /></div>
            <div style={S.field}><label style={S.lbl}>Heure</label><input style={S.input} type="time" value={editForm.time} onChange={e=>setEditForm(f=>({...f,time:e.target.value}))} /></div>
            <div style={S.field}><label style={S.lbl}>Participants</label><input style={S.input} type="number" min={1} value={editForm.participants} onChange={e=>setEditForm(f=>({...f,participants:e.target.value}))} /></div>
          </div>
          <div style={S.field}><label style={S.lbl}>Notes</label><textarea style={{ ...S.input, height:50, resize:'vertical' }} value={editForm.notes} onChange={e=>setEditForm(f=>({...f,notes:e.target.value}))} /></div>
          <div style={{ display:'flex', gap:6, marginBottom:12 }}>
            <button style={S.btn()} onClick={() => setEditing(false)}>Annuler</button>
            <button style={S.btn('primary')} onClick={handleUpdate}>Enregistrer</button>
          </div>
        </div>
      ) : (
        <>
          {[['Session',s?<span style={S.badge(s.bg,s.color)}>{s.label}</span>:'—'],['Kart',res.kart_type],['Participants',res.participants],['Total',s?s.price*res.participants+'€':'—'],['Acompte',s?s.deposit+'€':'—'],['Téléphone',res.phone],['Email',res.email||'—']].map(([l,v]) => (
            <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:'1px solid #f3f4f6', fontSize:13 }}>
              <span style={{ color:'#9ca3af' }}>{l}</span><span>{v}</span>
            </div>
          ))}
          {res.notes && <div style={{ marginTop:8, padding:'7px 9px', background:'#f9fafb', borderRadius:7, fontSize:12, color:'#6b7280' }}>📝 {res.notes}</div>}
          <div style={{ background:'#f9fafb', borderRadius:7, padding:'7px 10px', fontSize:11, margin:'10px 0' }}>
            <div style={{ color:'#9ca3af', marginBottom:2 }}>Lien acompte</div>
            <div style={{ color:'#1D9E75', wordBreak:'break-all' }}>{res.deposit_link}</div>
          </div>
        </>
      )}

      <div style={{ display:'flex', gap:6, justifyContent:'flex-end', flexWrap:'wrap' }}>
        <button style={S.btn('danger')} onClick={() => onDelete(res.id)}>Supprimer</button>
        <button style={S.btn()} onClick={() => setEditing(!editing)}>✏️ Modifier</button>
        <button style={S.btn()} onClick={() => onToggleAcompte(res.id)}>{res.acompte_paid?'Annuler acompte':'✓ Acompte'}</button>
        <button style={S.btn()} onClick={() => onToggleArrived(res.id)}>{res.arrived?'Annuler arrivée':'✓ Arrivé'}</button>
        <button style={S.btn('primary')} onClick={() => { showToast('📱 SMS — bientôt disponible'); onClose() }}>📱 SMS</button>
      </div>
    </div>
  )
}

// ─── CONFIG MODAL ─────────────────────────────────────────────────────────────
function ConfigModal({ cfg, onSave, onClose, showToast }) {
  const [form, setForm] = useState(JSON.parse(JSON.stringify(cfg)))
  const [section, setSection] = useState('general')

  function save() { onSave(form); onClose(); showToast('✓ Configuration enregistrée') }
  function updSess(id, field, val) { setForm(f => ({ ...f, sessions: f.sessions.map(s => s.id===id?{...s,[field]:val}:s) })) }
  function addSess() {
    const colors = ['#1D9E75','#BA7517','#E24B4A','#7F77DD','#378ADD']
    const bgs = ['#E1F5EE','#FAEEDA','#FCEBEB','#EEEDFE','#E6F1FB']
    const i = form.sessions.length % 5
    setForm(f => ({ ...f, sessions: [...f.sessions, { id:'s'+Date.now(), label:'Nouvelle', price:20, deposit:5, color:colors[i], bg:bgs[i] }] }))
  }
  function rmSess(id) { if(form.sessions.length<=1){alert('Min 1.');return} setForm(f=>({...f,sessions:f.sessions.filter(s=>s.id!==id)})) }

  return (
    <div style={{ ...S.modal, width:'min(540px,96vw)' }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:14 }}>
        <h3 style={{ fontSize:15, fontWeight:700 }}>Configuration</h3>
        <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#9ca3af' }}>✕</button>
      </div>
      <div style={{ display:'flex', gap:2, background:'#f0f1f3', borderRadius:8, padding:3, marginBottom:16 }}>
        {[['general','Général'],['horaires','Horaires'],['sessions','Sessions'],['sms','SMS']].map(([k,l]) => (
          <button key={k} style={S.tab(section===k)} onClick={()=>setSection(k)}>{l}</button>
        ))}
      </div>

      {section === 'general' && (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9 }}>
          <div style={S.field}><label style={S.lbl}>Nom</label><input style={S.input} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} /></div>
          <div style={S.field}><label style={S.lbl}>Ville</label><input style={S.input} value={form.city} onChange={e=>setForm(f=>({...f,city:e.target.value}))} /></div>
          <div style={S.field}><label style={S.lbl}>Karts adulte</label><input style={S.input} type="number" min={1} value={form.kart_adulte} onChange={e=>setForm(f=>({...f,kart_adulte:+e.target.value}))} /></div>
          <div style={S.field}><label style={S.lbl}>Karts enfant</label><input style={S.input} type="number" min={1} value={form.kart_enfant} onChange={e=>setForm(f=>({...f,kart_enfant:+e.target.value}))} /></div>
        </div>
      )}

      {section === 'horaires' && (
        <div>
          <div style={{ fontSize:11, color:'#6b7280', marginBottom:12, lineHeight:1.8, background:'#f9fafb', padding:'8px 10px', borderRadius:7 }}>
            📅 <b>Mer</b> 14h-22h · <b>Jeu</b> 16h-22h · <b>Ven</b> 16h-22h · <b>Sam</b> 14h-22h · <b>Dim</b> 14h-20h<br/>
            🏖️ <b>Vacances</b> : tous les jours 14h-22h<br/>
            🔑 <b>Lun/Mar</b> : fermés sauf jours exceptionnels ci-dessous<br/>
            ⏸ <b>Pauses auto</b> : toutes les heures piles · ⛽ 19h · 🍽️ 20h
          </div>

          <div style={{ fontSize:12, fontWeight:600, marginBottom:7 }}>🏖️ Vacances scolaires</div>
          {(form.vacances||[]).map((v,i) => (
            <div key={i} style={{ display:'flex', gap:6, alignItems:'center', marginBottom:7, flexWrap:'wrap' }}>
              <input style={{ ...S.input, width:110 }} placeholder="Label" value={v.label} onChange={e=>setForm(f=>{const vv=[...(f.vacances||[])];vv[i]={...vv[i],label:e.target.value};return{...f,vacances:vv}})} />
              <input style={{ ...S.input, width:130 }} type="date" value={v.start} onChange={e=>setForm(f=>{const vv=[...(f.vacances||[])];vv[i]={...vv[i],start:e.target.value};return{...f,vacances:vv}})} />
              <span style={{ color:'#9ca3af' }}>→</span>
              <input style={{ ...S.input, width:130 }} type="date" value={v.end} onChange={e=>setForm(f=>{const vv=[...(f.vacances||[])];vv[i]={...vv[i],end:e.target.value};return{...f,vacances:vv}})} />
              <button style={S.btn('danger')} onClick={()=>setForm(f=>({...f,vacances:(f.vacances||[]).filter((_,idx)=>idx!==i)}))}>✕</button>
            </div>
          ))}
          <button style={S.btn()} onClick={()=>setForm(f=>({...f,vacances:[...(f.vacances||[]),{start:todayStr(),end:todayStr(),label:'Vacances'}]}))}>+ Période</button>

          <div style={{ fontSize:12, fontWeight:600, marginTop:16, marginBottom:7 }}>🔑 Lun/Mar exceptionnels</div>
          {(form.jours_exceptionnels||[]).map((j,i) => (
            <div key={i} style={{ display:'flex', gap:7, alignItems:'center', marginBottom:7, flexWrap:'wrap' }}>
              <input style={{ ...S.input, width:140 }} type="date" value={j.date} onChange={e=>setForm(f=>{const je=[...(f.jours_exceptionnels||[])];je[i]={...je[i],date:e.target.value};return{...f,jours_exceptionnels:je}})} />
              <span style={{ fontSize:11 }}>14h →</span>
              <input style={{ ...S.input, width:55 }} type="number" min={15} max={23} value={j.close||20} onChange={e=>setForm(f=>{const je=[...(f.jours_exceptionnels||[])];je[i]={...je[i],open:14,close:+e.target.value};return{...f,jours_exceptionnels:je}})} />
              <span style={{ fontSize:11 }}>h</span>
              <button style={S.btn('danger')} onClick={()=>setForm(f=>({...f,jours_exceptionnels:(f.jours_exceptionnels||[]).filter((_,idx)=>idx!==i)}))}>✕</button>
            </div>
          ))}
          <button style={S.btn()} onClick={()=>setForm(f=>({...f,jours_exceptionnels:[...(f.jours_exceptionnels||[]),{date:todayStr(),open:14,close:20}]}))}>+ Jour</button>
        </div>
      )}

      {section === 'sessions' && (
        <div>
          <div style={{ fontSize:11, color:'#9ca3af', marginBottom:10 }}>2 sessions recommandées : ADULTES et ENFANTS</div>
          <div style={{ display:'grid', gridTemplateColumns:'18px 1fr 60px 65px 55px 55px 18px', gap:5, marginBottom:6, fontSize:10, color:'#9ca3af' }}>
            <div/><div>Nom</div><div>Prix €</div><div>Acompte €</div><div>Couleur</div><div>Fond</div><div/>
          </div>
          {form.sessions.map(s => (
            <div key={s.id} style={{ display:'grid', gridTemplateColumns:'18px 1fr 60px 65px 55px 55px 18px', gap:5, marginBottom:6, alignItems:'center' }}>
              <input type="color" value={s.color} onChange={e=>updSess(s.id,'color',e.target.value)} style={{ width:18, height:18, border:'none', cursor:'pointer', padding:0, borderRadius:3 }} />
              <input style={{ ...S.input, fontSize:12, padding:'4px 7px' }} value={s.label} onChange={e=>updSess(s.id,'label',e.target.value)} />
              <input style={{ ...S.input, fontSize:12, padding:'4px 7px' }} type="number" value={s.price} onChange={e=>updSess(s.id,'price',+e.target.value)} />
              <input style={{ ...S.input, fontSize:12, padding:'4px 7px' }} type="number" value={s.deposit} onChange={e=>updSess(s.id,'deposit',+e.target.value)} />
              <input type="color" value={s.bg} onChange={e=>updSess(s.id,'bg',e.target.value)} style={{ width:50, height:18, border:'none', cursor:'pointer', padding:0, borderRadius:3 }} />
              <div/>
              <button onClick={()=>rmSess(s.id)} style={{ background:'none', border:'none', cursor:'pointer', color:'#9ca3af', fontSize:14 }}>✕</button>
            </div>
          ))}
          <button onClick={addSess} style={{ background:'none', border:'1px dashed #e5e7eb', borderRadius:7, padding:'7px', width:'100%', fontSize:12, color:'#9ca3af', cursor:'pointer', marginTop:4 }}>+ Ajouter</button>
        </div>
      )}

      {section === 'sms' && (
        <div>
          <div style={{ background:'#FEF3C7', border:'1px solid #FCD34D', borderRadius:8, padding:'10px 12px', marginBottom:12, fontSize:12, color:'#92400E', lineHeight:1.6 }}>
            🔧 <b>SMS via Brevo</b> — à configurer prochainement.<br/>
            Entrez votre clé API pour activer l'envoi automatique à la confirmation.
          </div>
          <div style={S.field}>
            <label style={S.lbl}>Clé API Brevo</label>
            <input style={S.input} type="password" value={form.brevo_api_key||''} onChange={e=>setForm(f=>({...f,brevo_api_key:e.target.value}))} placeholder="xkeysib-..." />
            <div style={{ fontSize:11, color:'#9ca3af', marginTop:4 }}>app.brevo.com → SMTP &amp; API → Clés API</div>
          </div>
          <div style={S.field}>
            <label style={S.lbl}>Template SMS</label>
            <div style={{ fontSize:11, color:'#9ca3af', marginBottom:5 }}>Variables : {'{nom} {karting} {date} {heure} {session} {participants} {acompte} {lien}'}</div>
            <textarea style={{ ...S.input, height:80, resize:'vertical' }} value={form.sms} onChange={e=>setForm(f=>({...f,sms:e.target.value}))} />
          </div>
        </div>
      )}

      <div style={{ display:'flex', gap:6, justifyContent:'flex-end', marginTop:16, paddingTop:12, borderTop:'1px solid #f3f4f6' }}>
        <button style={S.btn()} onClick={()=>{ if(window.confirm('Réinitialiser ?')) setForm(JSON.parse(JSON.stringify(DEFAULT_CFG))) }}>Réinitialiser</button>
        <button style={S.btn('primary')} onClick={save}>Enregistrer</button>
      </div>
    </div>
  )
}
