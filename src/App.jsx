import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from './supabase'

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const DAYS = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim']
const MONTHS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre']
const MS = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc']

const DEFAULT_CFG = {
  name: 'Green Kart', city: 'Échirolles',
  open_hour: 9, close_hour: 21,
  kart_adulte: 15, kart_enfant: 12,
  sms: 'Bonjour {nom} ! Réservation confirmée au {karting}.\n{date} à {heure} · {session} ({duree}min) · {participants} pers.\nTotal {total}€ · Acompte {acompte}€ : {lien}',
  sessions: [
    { id:'s1', label:'Découverte', dur:10, price:15, deposit:5, color:'#1D9E75', bg:'#E1F5EE' },
    { id:'s2', label:'Sport', dur:15, price:22, deposit:8, color:'#BA7517', bg:'#FAEEDA' },
    { id:'s3', label:'Compétition', dur:20, price:30, deposit:10, color:'#E24B4A', bg:'#FCEBEB' },
    { id:'s4', label:'Anniversaire', dur:30, price:120, deposit:40, color:'#7F77DD', bg:'#EEEDFE' },
    { id:'s5', label:'Entreprise', dur:60, price:250, deposit:80, color:'#378ADD', bg:'#E6F1FB' },
  ],
  program_template: [
    { id:'pt1', type:'adulte', time:'09:00' },
    { id:'pt2', type:'enfant', time:'09:15' },
    { id:'pt3', type:'adulte', time:'09:30' },
    { id:'pt4', type:'enfant', time:'09:45' },
    { id:'pt5', type:'adulte', time:'10:00' },
    { id:'pt6', type:'enfant', time:'10:15' },
    { id:'pt7', type:'adulte', time:'10:30' },
    { id:'pt8', type:'adulte', time:'10:45' },
  ]
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
function getSlots(open, close) {
  const s = []
  for (let h = open; h < close; h++)
    for (let m = 0; m < 60; m += 15)
      s.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`)
  return s
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  app: { fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif', color: '#1a1a1a', background: '#fff', minHeight: '100vh', padding: '0 16px 60px' },
  topbar: { display:'flex', alignItems:'center', gap:8, padding:'12px 0 10px', borderBottom:'1px solid #e5e7eb', flexWrap:'wrap' },
  brand: { fontSize:15, fontWeight:600, color:'#111' },
  tabs: { display:'flex', gap:2, background:'#f3f4f6', borderRadius:8, padding:3 },
  tab: (active) => ({ padding:'5px 13px', fontSize:12, border:'none', background: active ? '#fff' : 'none', cursor:'pointer', borderRadius:6, fontWeight: active ? 500 : 400, color: active ? '#111' : '#6b7280', boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none', transition:'all 0.15s' }),
  btn: (variant='default') => ({
    background: variant==='primary' ? '#1D9E75' : variant==='danger' ? 'none' : 'none',
    border: variant==='primary' ? 'none' : variant==='danger' ? '1px solid #fca5a5' : '1px solid #e5e7eb',
    borderRadius:7, padding:'5px 12px', fontSize:12, cursor:'pointer',
    color: variant==='primary' ? '#fff' : variant==='danger' ? '#dc2626' : '#374151',
    fontWeight: variant==='primary' ? 500 : 400, transition:'all 0.15s',
  }),
  cap: { background:'#f9fafb', borderRadius:8, padding:'7px 14px' },
  capLabel: { fontSize:11, color:'#9ca3af', marginBottom:2 },
  capVal: { fontSize:15, fontWeight:600 },
  field: { marginBottom:11 },
  fieldLabel: { display:'block', fontSize:10, color:'#9ca3af', marginBottom:3, textTransform:'uppercase', letterSpacing:'0.4px' },
  input: { width:'100%', border:'1px solid #e5e7eb', borderRadius:7, padding:'7px 10px', fontSize:13, fontFamily:'inherit', outline:'none' },
  modal: { background:'#fff', border:'1px solid #e5e7eb', borderRadius:12, padding:20, width:'min(380px,96vw)', maxHeight:'88vh', overflowY:'auto', boxShadow:'0 20px 60px rgba(0,0,0,0.15)', animation:'fadeIn 0.15s ease' },
  overlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.3)', display:'flex', alignItems:'flex-start', justifyContent:'center', zIndex:1000, paddingTop:40, backdropFilter:'blur(2px)' },
  badge: (bg, color) => ({ display:'inline-block', fontSize:10, padding:'2px 7px', borderRadius:20, fontWeight:500, background:bg, color }),
  row: { display:'flex', alignItems:'center', gap:8, padding:'9px 11px', border:'1px solid #e5e7eb', borderRadius:8, marginBottom:5, background:'#fff', transition:'all 0.15s' },
  srow: { display:'flex', alignItems:'center', gap:8, padding:'8px 10px', border:'1px solid #e5e7eb', borderRadius:8, marginBottom:5, background:'#fff', cursor:'grab', userSelect:'none', transition:'box-shadow 0.15s' },
}

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [cfg, setCfg] = useState(() => {
    try { return JSON.parse(localStorage.getItem('gk_cfg')) || DEFAULT_CFG } catch { return DEFAULT_CFG }
  })
  const [reservations, setReservations] = useState([])
  const [progs, setProgs] = useState(() => {
    try { return JSON.parse(localStorage.getItem('gk_progs')) || {} } catch { return {} }
  })
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('cal')
  const [view, setView] = useState('semaine')
  const [curDate, setCurDate] = useState(new Date())
  const [modal, setModal] = useState(null)
  const [toast, setToast] = useState(null)
  const toastRef = useRef(null)

  // Supabase
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

  function saveCfg(newCfg) {
    setCfg(newCfg)
    try { localStorage.setItem('gk_cfg', JSON.stringify(newCfg)) } catch {}
  }

  function saveProgs(newProgs) {
    setProgs(newProgs)
    try { localStorage.setItem('gk_progs', JSON.stringify(newProgs)) } catch {}
  }

  function showToast(msg) {
    setToast(msg)
    clearTimeout(toastRef.current)
    toastRef.current = setTimeout(() => setToast(null), 4000)
  }

  // Programme du jour
  function getProgForDate(dateStr) {
    if (progs[dateStr]) return progs[dateStr]
    const prog = cfg.program_template.map(p => ({ ...p, id: 'p' + Date.now() + Math.random().toString(36).substr(2,4) }))
    const newProgs = { ...progs, [dateStr]: prog }
    saveProgs(newProgs)
    return prog
  }

  function isBlocked(dateStr, time) {
    return getProgForDate(dateStr).some(p => p.type === 'event' && p.time === time)
  }

  function getSlotInfo(dateStr, time) {
    return getProgForDate(dateStr).find(p => p.time === time) || null
  }

  function getResAt(dateStr, time) {
    return reservations.filter(r => r.date === dateStr && r.time === time)
  }

  function getKartCount(dateStr, time, kt) {
    return reservations.filter(r => r.date === dateStr && r.time === time && r.kart_type === kt)
      .reduce((s, r) => s + (r.participants || 1), 0)
  }

  // Navigation
  function nav(dir) {
    const d = new Date(curDate)
    d.setDate(d.getDate() + dir * (view === 'semaine' ? 7 : 1))
    setCurDate(d)
  }

  const days = view === 'semaine' ? getWeekDays(curDate) : [curDate]
  const slots = getSlots(cfg.open_hour, cfg.close_hour)
  const ts = todayStr()

  // ─── RESERVATION CRUD ─────────────────────────────────────────────────────
  async function saveReservation(dateStr, time, form) {
    const s = cfg.sessions.find(x => x.id === form.session) || cfg.sessions[0]
    const id = Date.now().toString(36) + Math.random().toString(36).substr(2,5)
    const { error } = await supabase.from('reservations').insert({
      id, date: dateStr, time,
      name: form.name, phone: form.phone, email: form.email || null,
      session: s.id, participants: parseInt(form.participants),
      kart_type: form.kartType, notes: form.notes || null,
      deposit_link: `https://pay.greenkart.fr/${id}`,
      arrived: false, acompte_paid: false,
    })
    if (error) { showToast('Erreur lors de la sauvegarde'); return }
    setModal(null)
    showToast(`✓ Réservé · SMS envoyé au ${form.phone}`)
  }

  async function toggleArrived(id) {
    const r = reservations.find(x => x.id === id)
    if (!r) return
    await supabase.from('reservations').update({ arrived: !r.arrived }).eq('id', id)
    showToast(r.arrived ? `${r.name} marqué en attente` : `✓ ${r.name} est arrivé`)
  }

  async function toggleAcompte(id) {
    const r = reservations.find(x => x.id === id)
    if (!r) return
    await supabase.from('reservations').update({ acompte_paid: !r.acompte_paid }).eq('id', id)
    showToast(r.acompte_paid ? `Acompte annulé` : `💳 Acompte reçu`)
  }

  async function deleteRes(id) {
    if (!window.confirm('Supprimer cette réservation ?')) return
    await supabase.from('reservations').delete().eq('id', id)
    setModal(null)
    showToast('Réservation supprimée')
  }

  // ─── DRAG & DROP (aujourd'hui) ─────────────────────────────────────────────
  const dragRef = useRef(null)

  function onDragStart(dateStr, time) { dragRef.current = { dateStr, time } }
  function onDrop(dateStr, dropTime) {
    if (!dragRef.current || dragRef.current.time === dropTime) return
    const { time: srcTime } = dragRef.current
    const prog = [...getProgForDate(dateStr)]
    const srcIdx = prog.findIndex(p => p.time === srcTime)
    const tgtIdx = prog.findIndex(p => p.time === dropTime)
    if (srcIdx >= 0 && tgtIdx >= 0) {
      const tmp = prog[srcIdx].time; prog[srcIdx].time = prog[tgtIdx].time; prog[tgtIdx].time = tmp
    }
    // Déplacer les réservations aussi
    const updRes = reservations.map(r => {
      if (r.date === dateStr && r.time === srcTime) return { ...r, time: dropTime }
      if (r.date === dateStr && r.time === dropTime) return { ...r, time: srcTime }
      return r
    })
    // Update Supabase en masse
    updRes.filter(r => r.date === dateStr && (r.time === srcTime || r.time === dropTime))
      .forEach(r => supabase.from('reservations').update({ time: r.time }).eq('id', r.id))
    saveProgs({ ...progs, [dateStr]: prog })
    dragRef.current = null
    showToast('Créneaux échangés · Réservations déplacées')
  }

  // ─── DRAG & DROP (programme template) ─────────────────────────────────────
  const dragProgRef = useRef(null)
  function onDragStartProg(id) { dragProgRef.current = id }
  function onDropProg(targetId) {
    if (!dragProgRef.current || dragProgRef.current === targetId) return
    const tmpl = [...cfg.program_template]
    const src = tmpl.find(x => x.id === dragProgRef.current)
    const tgt = tmpl.find(x => x.id === targetId)
    if (src && tgt) { const tmp = src.time; src.time = tgt.time; tgt.time = tmp }
    saveCfg({ ...cfg, program_template: tmpl })
    dragProgRef.current = null
    showToast('Créneaux échangés dans le programme type')
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
        <div style={{ position:'fixed', top:16, right:16, zIndex:2000, background:'#fff', border:'1px solid #e5e7eb', borderLeft:'3px solid #1D9E75', borderRadius:8, padding:'10px 14px', fontSize:13, boxShadow:'0 4px 20px rgba(0,0,0,0.1)', animation:'fadeIn 0.2s ease' }}>
          {toast}
        </div>
      )}

      {/* TOPBAR */}
      <div style={S.topbar}>
        <div style={S.brand}>{cfg.name} <span style={{ fontSize:12, fontWeight:400, color:'#9ca3af' }}>{cfg.city}</span></div>
        <div style={S.tabs}>
          <button style={S.tab(tab==='cal')} onClick={() => setTab('cal')}>📅 Calendrier</button>
          <button style={S.tab(tab==='today')} onClick={() => setTab('today')}>🏁 Aujourd'hui</button>
          <button style={S.tab(tab==='prog')} onClick={() => setTab('prog')}>📋 Programme</button>
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

      {/* CAPS + LEGEND */}
      <div style={{ display:'flex', gap:8, marginTop:8, flexWrap:'wrap' }}>
        <div style={S.cap}><div style={S.capLabel}>Karts adulte</div><div style={{ ...S.capVal, color:'#1D9E75' }}>{cfg.kart_adulte} max</div></div>
        <div style={S.cap}><div style={S.capLabel}>Karts enfant</div><div style={{ ...S.capVal, color:'#BA7517' }}>{cfg.kart_enfant} max</div></div>
        <div style={{ ...S.cap, marginLeft:'auto' }}><div style={S.capLabel}>Total réservations</div><div style={S.capVal}>{reservations.length}</div></div>
      </div>
      <div style={{ display:'flex', gap:10, padding:'7px 0', borderBottom:'1px solid #e5e7eb', flexWrap:'wrap', fontSize:11, color:'#6b7280', marginTop:6 }}>
        <span style={{ fontWeight:500 }}>Sessions :</span>
        {cfg.sessions.map(s => <span key={s.id}><span style={{ display:'inline-block', width:8, height:8, borderRadius:2, background:s.color, marginRight:4 }} />{s.label} {s.dur}min {s.price}€</span>)}
        <span style={{ color:'#d1d5db' }}>|</span>
        <span><span style={{ display:'inline-block', width:8, height:8, borderRadius:'50%', background:'#F59E0B', marginRight:4 }} />Événement bloquant</span>
      </div>

      {/* ── CALENDRIER ── */}
      {tab === 'cal' && (
        <div style={{ overflowX:'auto', marginTop:0 }}>
          <div style={{ display:'grid', gridTemplateColumns:`48px repeat(${days.length}, minmax(${view==='jour'?'400px':'90px'}, 1fr))`, minWidth: view==='jour' ? 448 : 690 }}>
            {/* Headers */}
            <div style={{ borderBottom:'1px solid #e5e7eb', position:'sticky', top:0, background:'#fff', zIndex:10 }} />
            {days.map((d, i) => {
              const ds = fmtDate(d), isT = ds === ts
              const ac = reservations.filter(r=>r.date===ds&&r.kart_type==='adulte').reduce((s,r)=>s+r.participants,0)
              const ec = reservations.filter(r=>r.date===ds&&r.kart_type==='enfant').reduce((s,r)=>s+r.participants,0)
              return (
                <div key={i} onClick={() => { if(view==='semaine'){setCurDate(new Date(ds+'T12:00:00'));setView('jour')} }}
                  style={{ fontSize:11, color: isT?'#1D9E75':'#9ca3af', padding:'7px 3px 5px', textAlign:'center', borderBottom:'1px solid #e5e7eb', borderLeft:'1px solid #f3f4f6', position:'sticky', top:0, background:'#fff', zIndex:10, cursor:'pointer' }}>
                  <div>{DAYS[i%7]}</div>
                  <div style={{ fontSize:18, fontWeight:600, color: isT?'#1D9E75':'#111', lineHeight:1.1 }}>{d.getDate()}</div>
                  <div style={{ display:'flex', gap:2, justifyContent:'center', marginTop:2 }}>
                    {ac>0 && <span style={{ fontSize:9, background:'#E1F5EE', color:'#0F6E56', padding:'1px 3px', borderRadius:8 }}>A:{ac}</span>}
                    {ec>0 && <span style={{ fontSize:9, background:'#FAEEDA', color:'#854F0B', padding:'1px 3px', borderRadius:8 }}>E:{ec}</span>}
                  </div>
                </div>
              )
            })}
            {/* Rows */}
            {slots.map(time => {
              const isH = time.endsWith(':00')
              return [
                <div key={`t-${time}`} style={{ fontSize:10, color: isH?'#9ca3af':'transparent', textAlign:'right', paddingRight:5, display:'flex', alignItems:'flex-start', justifyContent:'flex-end', paddingTop:2, borderBottom:`1px solid ${isH?'#e5e7eb':'#f9fafb'}`, height:36 }}>{time}</div>,
                ...days.map((day, di) => {
                  const ds = fmtDate(day)
                  const blocked = isBlocked(ds, time)
                  const slotInfo = getSlotInfo(ds, time)
                  const sr = getResAt(ds, time)
                  const au = getKartCount(ds, time, 'adulte')
                  const eu = getKartCount(ds, time, 'enfant')
                  return (
                    <div key={`s-${time}-${di}`}
                      onClick={() => !blocked && setModal({ type:'new', dateStr:ds, time })}
                      style={{ height:36, borderBottom:`1px solid ${isH?'#e5e7eb':'#f9fafb'}`, borderLeft:'1px solid #f3f4f6', background: blocked?'#FFFBEB':'#fff', position:'relative', cursor: blocked?'default':'pointer' }}
                      onMouseEnter={e => { if(!blocked) e.currentTarget.style.background='#f9fafb' }}
                      onMouseLeave={e => { e.currentTarget.style.background = blocked?'#FFFBEB':'#fff' }}
                    >
                      {blocked && slotInfo && (
                        <div style={{ position:'absolute', inset:'2px 2px', borderRadius:3, background:'#FDE8C8', display:'flex', alignItems:'center', padding:'0 6px', fontSize:10, fontWeight:600, color:'#92400E', gap:4 }}>
                          ⚡ {slotInfo.label || 'Événement'}
                        </div>
                      )}
                      {!blocked && sr.map((r, ri) => {
                        const s = cfg.sessions.find(x => x.id === r.session)
                        const w = 100 / sr.length
                        return (
                          <div key={r.id} onClick={e => { e.stopPropagation(); setModal({ type:'detail', res:r }) }}
                            style={{ position:'absolute', top:2, bottom:2, left:`${ri*w}%`, width:`calc(${w}% - 3px)`, background:s?s.bg:'#f3f4f6', border:`1px solid ${s?s.color:'#e5e7eb'}`, borderRadius:3, padding:'0 4px', fontSize:10, fontWeight:500, color:s?s.color:'#374151', overflow:'hidden', whiteSpace:'nowrap', textOverflow:'ellipsis', display:'flex', alignItems:'center', gap:3, cursor:'pointer', opacity:r.arrived?0.5:1, borderTop:r.acompte_paid?`2px solid ${s?s.color:'#1D9E75'}`:undefined }}>
                            <span style={{ fontSize:8 }}>{r.kart_type==='adulte'?'A':'E'}</span>
                            {r.arrived?'✓ ':''}{r.name}·{r.participants}p
                          </div>
                        )
                      })}
                      {!blocked && sr.length === 0 && (au > 0 || eu > 0) && (
                        <div style={{ position:'absolute', bottom:1, right:2, display:'flex', gap:2 }}>
                          {au>0 && <span style={{ fontSize:9, background:'#E1F5EE', color:'#0F6E56', padding:'1px 3px', borderRadius:3 }}>A:{au}/{cfg.kart_adulte}</span>}
                          {eu>0 && <span style={{ fontSize:9, background:'#FAEEDA', color:'#854F0B', padding:'1px 3px', borderRadius:3 }}>E:{eu}/{cfg.kart_enfant}</span>}
                        </div>
                      )}
                    </div>
                  )
                })
              ]
            })}
          </div>
          <div style={{ display:'flex', gap:14, padding:'7px 0', borderTop:'1px solid #e5e7eb', fontSize:12, color:'#9ca3af', marginTop:4 }}>
            <span>Adulte : {totalA} karts réservés</span>
            <span>Enfant : {totalE} karts réservés</span>
            <span style={{ marginLeft:'auto' }}>● en direct</span>
          </div>
        </div>
      )}

      {/* ── AUJOURD'HUI ── */}
      {tab === 'today' && <TodayPage cfg={cfg} reservations={reservations} progs={progs} saveProgs={saveProgs} getProgForDate={getProgForDate} onDragStart={onDragStart} onDrop={onDrop} toggleArrived={toggleArrived} toggleAcompte={toggleAcompte} setModal={setModal} showToast={showToast} />}

      {/* ── PROGRAMME ── */}
      {tab === 'prog' && <ProgPage cfg={cfg} saveCfg={saveCfg} onDragStartProg={onDragStartProg} onDropProg={onDropProg} showToast={showToast} />}

      {/* ── MODALS ── */}
      {modal && (
        <div style={S.overlay} onClick={() => setModal(null)}>
          <div onClick={e => e.stopPropagation()}>
            {modal.type === 'new' && <NewResModal cfg={cfg} dateStr={modal.dateStr} time={modal.time} reservations={reservations} onSave={saveReservation} onClose={() => setModal(null)} />}
            {modal.type === 'detail' && <DetailModal cfg={cfg} res={modal.res} onToggleArrived={toggleArrived} onToggleAcompte={toggleAcompte} onDelete={deleteRes} onClose={() => setModal(null)} showToast={showToast} />}
            {modal.type === 'config' && <ConfigModal cfg={cfg} onSave={saveCfg} onClose={() => setModal(null)} showToast={showToast} />}
            {modal.type === 'editSlot' && <EditSlotModal dateStr={modal.dateStr} time={modal.time} slot={modal.slot} progs={progs} saveProgs={saveProgs} onClose={() => setModal(null)} showToast={showToast} />}
            {modal.type === 'addEvent' && <AddEventModal dateStr={modal.dateStr} progs={progs} saveProgs={saveProgs} onClose={() => setModal(null)} showToast={showToast} />}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── TODAY PAGE ───────────────────────────────────────────────────────────────
function TodayPage({ cfg, reservations, progs, saveProgs, getProgForDate, onDragStart, onDrop, toggleArrived, toggleAcompte, setModal, showToast }) {
  const ts = todayStr()
  const d = new Date()
  const prog = [...getProgForDate(ts)].sort((a,b) => a.time.localeCompare(b.time))
  const todayRes = reservations.filter(r => r.date === ts)
  const arrived = todayRes.filter(r => r.arrived).length
  const acomptes = todayRes.filter(r => r.acompte_paid).length
  const [dragOver, setDragOver] = useState(null)

  const times = [...new Set([...prog.map(p=>p.time), ...todayRes.map(r=>r.time)])].sort()

  return (
    <div style={{ paddingTop:14 }}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:14, flexWrap:'wrap', gap:8 }}>
        <div>
          <div style={{ fontSize:16, fontWeight:600 }}>Aujourd'hui</div>
          <div style={{ fontSize:12, color:'#9ca3af' }}>{d.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</div>
        </div>
        <div style={{ display:'flex', gap:7, flexWrap:'wrap' }}>
          {[['Réservations',todayRes.length,'#111'],['Arrivés',arrived,'#1D9E75'],['En attente',todayRes.length-arrived,'#374151'],['Acomptes',acomptes,'#1D9E75']].map(([l,v,c]) => (
            <div key={l} style={{ background:'#f9fafb', borderRadius:8, padding:'6px 12px', textAlign:'center' }}>
              <div style={{ fontSize:17, fontWeight:600, color:c }}>{v}</div>
              <div style={{ fontSize:11, color:'#9ca3af' }}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {times.length === 0 && <div style={{ textAlign:'center', padding:'36px 0', color:'#9ca3af', fontSize:13 }}>Aucun créneau aujourd'hui</div>}

      {times.map(time => {
        const pslot = prog.find(p => p.time === time)
        const slotRes = todayRes.filter(r => r.time === time)
        const isEvent = pslot?.type === 'event'
        const isA = pslot?.type === 'adulte'

        return (
          <div key={time} style={{ marginBottom:12 }}
            onDragOver={e => { e.preventDefault(); setDragOver(time) }}
            onDragLeave={() => setDragOver(null)}
            onDrop={e => { e.preventDefault(); setDragOver(null); onDrop(ts, time) }}
          >
            {/* Slot header */}
            {pslot && (
              <div draggable onDragStart={() => onDragStart(ts, time)}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', border:`1px solid ${dragOver===time?'#1D9E75':isEvent?'#FCD34D':'#e5e7eb'}`, borderRadius:8, marginBottom:4, background: isEvent?'#FFFBEB':'#fff', cursor:'grab', userSelect:'none' }}>
                <span style={{ fontSize:14, color:'#9ca3af' }}>⠿</span>
                <span style={{ fontSize:13, fontWeight:500, minWidth:44, color:'#6b7280' }}>{time}</span>
                <span style={{ fontSize:12, padding:'2px 10px', borderRadius:20, fontWeight:500, background:isEvent?'#FDE8C8':isA?'#E1F5EE':'#FAEEDA', color:isEvent?'#92400E':isA?'#0F6E56':'#854F0B' }}>
                  {isEvent ? `⚡ ${pslot.label||'Événement'}` : isA ? 'Adulte' : 'Enfant'}
                </span>
                <div style={{ marginLeft:'auto', display:'flex', gap:5 }}>
                  <button style={S.btn()} onClick={() => setModal({ type:'editSlot', dateStr:ts, time, slot:pslot })} onMouseDown={e=>e.stopPropagation()}>Modifier</button>
                  {!isEvent && <button style={S.btn('primary')} onClick={() => setModal({ type:'new', dateStr:ts, time })} onMouseDown={e=>e.stopPropagation()}>+ Résa</button>}
                </div>
              </div>
            )}

            {/* Réservations */}
            {!isEvent && slotRes.map(r => {
              const s = cfg.sessions.find(x => x.id === r.session)
              return (
                <div key={r.id} style={{ ...S.row, marginLeft:16, background: r.arrived?'#f9fafb':'#fff', opacity:1 }}>
                  <div onClick={() => toggleArrived(r.id)} style={{ width:22, height:22, borderRadius:'50%', border:`1.5px solid ${r.arrived?'#1D9E75':'#d1d5db'}`, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, background:r.arrived?'#1D9E75':'none', color:r.arrived?'#fff':'transparent', flexShrink:0 }}>✓</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:500, textDecoration:r.arrived?'line-through':'none', color:r.arrived?'#9ca3af':'#111', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{r.name}</div>
                    <div style={{ fontSize:11, color:'#9ca3af', marginTop:1 }}>
                      <span style={S.badge(s?s.bg:'#f3f4f6', s?s.color:'#374151')}>{s?.label||'?'}</span>
                      <span style={S.badge(r.kart_type==='adulte'?'#E1F5EE':'#FAEEDA', r.kart_type==='adulte'?'#0F6E56':'#854F0B')}>{r.kart_type==='adulte'?'Adulte':'Enfant'}</span>
                      {r.participants} pers · {s?s.price*r.participants:'?'}€{r.phone?' · '+r.phone:''}
                    </div>
                    {r.notes && <div style={{ fontSize:10, color:'#d1d5db', marginTop:1 }}>📝 {r.notes}</div>}
                  </div>
                  <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:5, flexShrink:0 }}>
                    <button onClick={() => toggleAcompte(r.id)} style={{ display:'flex', alignItems:'center', gap:4, fontSize:11, padding:'3px 9px', borderRadius:20, border:`1px solid ${r.acompte_paid?'#1D9E75':'#e5e7eb'}`, cursor:'pointer', background:r.acompte_paid?'#E1F5EE':'none', color:r.acompte_paid?'#0F6E56':'#9ca3af', fontWeight:r.acompte_paid?500:400 }}>
                      {r.acompte_paid?'✓ Acompte reçu':`Acompte ${s?.deposit||'?'}€`}
                    </button>
                    <button style={S.btn()} onClick={() => setModal({ type:'detail', res:r })}>Détails</button>
                  </div>
                </div>
              )
            })}
            {!isEvent && pslot && slotRes.length === 0 && (
              <div style={{ marginLeft:16, fontSize:11, color:'#d1d5db', padding:'4px 0' }}>Aucune réservation</div>
            )}
          </div>
        )
      })}

      <button style={{ ...S.btn(), width:'100%', marginTop:8, padding:'9px' }} onClick={() => setModal({ type:'addEvent', dateStr:ts })}>
        + Ajouter un événement ou créneau
      </button>
    </div>
  )
}

// ─── PROG PAGE ────────────────────────────────────────────────────────────────
function ProgPage({ cfg, saveCfg, onDragStartProg, onDropProg, showToast }) {
  const tmpl = [...cfg.program_template].sort((a,b) => a.time.localeCompare(b.time))
  const [dragOver, setDragOver] = useState(null)

  function updTime(id, val) { saveCfg({ ...cfg, program_template: cfg.program_template.map(p => p.id===id?{...p,time:val}:p) }) }
  function updLabel(id, val) { saveCfg({ ...cfg, program_template: cfg.program_template.map(p => p.id===id?{...p,label:val}:p) }) }
  function updType(id, val) { saveCfg({ ...cfg, program_template: cfg.program_template.map(p => p.id===id?{...p,type:val}:p) }) }
  function remove(id) { if(cfg.program_template.length<=1){alert('Min 1 créneau.');return;} saveCfg({ ...cfg, program_template: cfg.program_template.filter(p=>p.id!==id) }) }
  function add(type) { saveCfg({ ...cfg, program_template: [...cfg.program_template, { id:'pt'+Date.now(), type, time:'12:00', label:type==='event'?'Relâche essence':'' }] }) }

  return (
    <div style={{ paddingTop:14 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14, flexWrap:'wrap', gap:8 }}>
        <div>
          <div style={{ fontSize:15, fontWeight:600 }}>Programme type</div>
          <div style={{ fontSize:12, color:'#9ca3af' }}>Modèle appliqué à chaque nouvelle journée · Glisser-déposer pour réorganiser</div>
        </div>
        <div style={{ display:'flex', gap:5 }}>
          <button style={S.btn()} onClick={() => add('adulte')}>+ Adulte</button>
          <button style={S.btn()} onClick={() => add('enfant')}>+ Enfant</button>
          <button style={S.btn()} onClick={() => add('event')}>+ Événement</button>
        </div>
      </div>

      {tmpl.map(p => {
        const isEv = p.type==='event', isA = p.type==='adulte'
        return (
          <div key={p.id} draggable onDragStart={() => onDragStartProg(p.id)}
            onDragOver={e => { e.preventDefault(); setDragOver(p.id) }}
            onDragLeave={() => setDragOver(null)}
            onDrop={e => { e.preventDefault(); setDragOver(null); onDropProg(p.id) }}
            style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', border:`1px solid ${dragOver===p.id?'#1D9E75':'#e5e7eb'}`, borderRadius:8, marginBottom:5, background:isEv?'#FFFBEB':'#fff', cursor:'grab', userSelect:'none' }}>
            <span style={{ fontSize:14, color:'#9ca3af' }}>⠿</span>
            <select value={p.type} onChange={e=>updType(p.id,e.target.value)} style={{ border:'1px solid #e5e7eb', borderRadius:6, padding:'3px 6px', fontSize:11, background:'#fff' }} onMouseDown={e=>e.stopPropagation()}>
              <option value="adulte">Adulte</option>
              <option value="enfant">Enfant</option>
              <option value="event">Événement</option>
            </select>
            <input type="time" value={p.time} onChange={e=>updTime(p.id,e.target.value)} onMouseDown={e=>e.stopPropagation()} style={{ border:'1px solid #e5e7eb', borderRadius:6, padding:'3px 6px', fontSize:12, background:'#fff' }} />
            {isEv && <input value={p.label||''} onChange={e=>updLabel(p.id,e.target.value)} placeholder="Nom de l'événement" onMouseDown={e=>e.stopPropagation()} style={{ border:'1px solid #e5e7eb', borderRadius:6, padding:'3px 8px', fontSize:12, flex:1, background:'#fff' }} />}
            {!isEv && <span style={{ fontSize:12, padding:'2px 10px', borderRadius:20, background:isA?'#E1F5EE':'#FAEEDA', color:isA?'#0F6E56':'#854F0B' }}>{isA?'Adulte':'Enfant'}</span>}
            <button style={S.btn('danger')} onClick={()=>remove(p.id)} onMouseDown={e=>e.stopPropagation()}>✕</button>
          </div>
        )
      })}

      <div style={{ display:'flex', gap:8, marginTop:14, paddingTop:12, borderTop:'1px solid #e5e7eb' }}>
        <button style={S.btn()} onClick={() => { if(window.confirm('Réinitialiser le programme type ?')){saveCfg({...cfg,program_template:DEFAULT_CFG.program_template});showToast('Programme réinitialisé')} }}>Réinitialiser</button>
        <div style={{ fontSize:11, color:'#d1d5db', display:'flex', alignItems:'center' }}>Les modifications s'appliquent aux nouvelles journées uniquement.</div>
      </div>
    </div>
  )
}

// ─── NEW RES MODAL ────────────────────────────────────────────────────────────
function NewResModal({ cfg, dateStr, time, reservations, onSave, onClose }) {
  const [form, setForm] = useState({ name:'', phone:'', email:'', session:cfg.sessions[0]?.id||'', kartType:'adulte', participants:1, notes:'' })
  const d = new Date(dateStr+'T12:00:00')
  const au = reservations.filter(r=>r.date===dateStr&&r.time===time&&r.kart_type==='adulte').reduce((s,r)=>s+r.participants,0)
  const eu = reservations.filter(r=>r.date===dateStr&&r.time===time&&r.kart_type==='enfant').reduce((s,r)=>s+r.participants,0)
  const ar = cfg.kart_adulte - au, er = cfg.kart_enfant - eu
  const s = cfg.sessions.find(x=>x.id===form.session)||cfg.sessions[0]
  const msg = (cfg.sms||'').replace('{nom}',form.name||'[Nom]').replace('{karting}',cfg.name+' '+cfg.city).replace('{date}',d.toLocaleDateString('fr-FR')).replace('{heure}',time).replace('{session}',s?.label||'').replace('{duree}',s?.dur||'').replace('{participants}',form.participants).replace('{total}',s?s.price*form.participants:0).replace('{acompte}',s?.deposit||'').replace('{lien}','[lien paiement]')

  function handleSave() {
    if(!form.name.trim()||!form.phone.trim()){alert('Nom et téléphone obligatoires.');return}
    const max = form.kartType==='adulte'?cfg.kart_adulte:cfg.kart_enfant
    const used = form.kartType==='adulte'?au:eu
    if(used+parseInt(form.participants)>max){alert(`Capacité dépassée ! ${max-used} kart(s) dispo.`);return}
    onSave(dateStr, time, form)
  }

  return (
    <div style={S.modal}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
        <h3 style={{ fontSize:15, fontWeight:600 }}>Nouvelle réservation</h3>
        <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#9ca3af' }}>✕</button>
      </div>
      <div style={{ fontSize:12, color:'#9ca3af', marginBottom:13 }}>{d.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})} à {time}</div>

      <div style={S.field}>
        <label style={S.fieldLabel}>Type de kart</label>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:6 }}>
          {[{id:'adulte',label:'Adulte',rem:ar,max:cfg.kart_adulte,c:'#1D9E75'},{id:'enfant',label:'Enfant',rem:er,max:cfg.kart_enfant,c:'#BA7517'}].map(kt => (
            <div key={kt.id} onClick={()=>setForm(f=>({...f,kartType:kt.id}))} style={{ border:`${form.kartType===kt.id?'1.5px':'1px'} solid ${form.kartType===kt.id?kt.c:'#e5e7eb'}`, borderRadius:7, padding:'8px 10px', cursor:'pointer', background:form.kartType===kt.id?kt.c+'11':'#fff' }}>
              <div style={{ fontSize:12, fontWeight:500 }}>{kt.label}</div>
              <div style={{ fontSize:11, color:kt.rem<=3?'#dc2626':kt.c }}>{kt.rem}/{kt.max} disponibles</div>
            </div>
          ))}
        </div>
      </div>

      <div style={S.field}>
        <label style={S.fieldLabel}>Session</label>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:5 }}>
          {cfg.sessions.map(ss => (
            <div key={ss.id} onClick={()=>setForm(f=>({...f,session:ss.id}))} style={{ border:`${form.session===ss.id?'1.5px':'1px'} solid ${form.session===ss.id?ss.color:'#e5e7eb'}`, borderRadius:7, padding:'7px 9px', cursor:'pointer', background:form.session===ss.id?ss.color+'11':'#fff' }}>
              <div style={{ fontSize:12, fontWeight:500, color:ss.color }}>{ss.label}</div>
              <div style={{ fontSize:11, color:'#9ca3af' }}>{ss.dur}min · {ss.price}€</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9 }}>
        <div style={S.field}><label style={S.fieldLabel}>Nom *</label><input style={S.input} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="Jean Dupont" /></div>
        <div style={S.field}><label style={S.fieldLabel}>Participants</label><input style={S.input} type="number" min={1} max={20} value={form.participants} onChange={e=>setForm(f=>({...f,participants:e.target.value}))} /></div>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9 }}>
        <div style={S.field}><label style={S.fieldLabel}>Téléphone *</label><input style={S.input} value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} placeholder="+33 6 12 34 56 78" /></div>
        <div style={S.field}><label style={S.fieldLabel}>Email</label><input style={S.input} type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="jean@email.fr" /></div>
      </div>
      <div style={S.field}><label style={S.fieldLabel}>Notes internes</label><textarea style={{ ...S.input, height:52, resize:'vertical' }} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))} placeholder="Infos complémentaires..." /></div>

      <div style={{ background:'#f9fafb', borderRadius:7, padding:'9px 11px', fontSize:12, lineHeight:1.75, color:'#6b7280', marginBottom:12 }}>
        <strong style={{ color:'#374151' }}>Message client :</strong><br />
        {msg.split('\n').map((l,i) => <span key={i}>{l}<br /></span>)}
        {form.phone && <span style={{ fontSize:10, color:'#d1d5db' }}>SMS → {form.phone}</span>}
      </div>

      <div style={{ display:'flex', gap:7, justifyContent:'flex-end' }}>
        <button style={S.btn()} onClick={onClose}>Annuler</button>
        <button style={S.btn('primary')} onClick={handleSave}>Confirmer et envoyer</button>
      </div>
    </div>
  )
}

// ─── DETAIL MODAL ─────────────────────────────────────────────────────────────
function DetailModal({ cfg, res, onToggleArrived, onToggleAcompte, onDelete, onClose, showToast }) {
  const s = cfg.sessions.find(x => x.id === res.session)
  const d = new Date(res.date+'T12:00:00')
  return (
    <div style={S.modal}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
        <h3 style={{ fontSize:15, fontWeight:600 }}>{res.name}</h3>
        <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#9ca3af' }}>✕</button>
      </div>
      <div style={{ fontSize:12, color:'#9ca3af', marginBottom:12 }}>{d.toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})} à {res.time}</div>
      <div style={{ display:'flex', gap:6, marginBottom:13, flexWrap:'wrap' }}>
        <span style={{ fontSize:12, padding:'4px 10px', borderRadius:20, background:res.arrived?'#E1F5EE':'#f3f4f6', color:res.arrived?'#0F6E56':'#6b7280' }}>{res.arrived?'✓ Arrivé':'En attente'}</span>
        <span style={{ fontSize:12, padding:'4px 10px', borderRadius:20, background:res.acompte_paid?'#E1F5EE':'#f3f4f6', color:res.acompte_paid?'#0F6E56':'#6b7280' }}>💳 {res.acompte_paid?'Acompte reçu':'Acompte en attente'}</span>
      </div>
      {[['Session',s?<span style={S.badge(s.bg,s.color)}>{s.label}</span>:'—'],['Kart',res.kart_type==='adulte'?'Adulte':'Enfant'],['Durée',s?s.dur+'min':'—'],['Participants',res.participants],['Total',s?s.price*res.participants+'€':'—'],['Acompte',s?s.deposit+'€':'—'],['Téléphone',res.phone],['Email',res.email||'—']].map(([l,v]) => (
        <div key={l} style={{ display:'flex', justifyContent:'space-between', padding:'5px 0', borderBottom:'1px solid #f3f4f6', fontSize:13 }}>
          <span style={{ color:'#9ca3af' }}>{l}</span><span>{v}</span>
        </div>
      ))}
      {res.notes && <div style={{ marginTop:8, padding:'7px 9px', background:'#f9fafb', borderRadius:7, fontSize:12, color:'#6b7280' }}>{res.notes}</div>}
      <div style={{ background:'#f9fafb', borderRadius:7, padding:'7px 10px', fontSize:11, margin:'12px 0' }}>
        <div style={{ color:'#9ca3af', marginBottom:2 }}>Lien acompte</div>
        <div style={{ color:'#1D9E75', wordBreak:'break-all' }}>{res.deposit_link}</div>
      </div>
      <div style={{ display:'flex', gap:6, justifyContent:'flex-end', flexWrap:'wrap' }}>
        <button style={S.btn('danger')} onClick={() => onDelete(res.id)}>Supprimer</button>
        <button style={S.btn()} onClick={() => onToggleAcompte(res.id)}>{res.acompte_paid?'Annuler acompte':'✓ Acompte reçu'}</button>
        <button style={S.btn()} onClick={() => onToggleArrived(res.id)}>{res.arrived?'Annuler arrivée':'✓ Marquer arrivé'}</button>
        <button style={S.btn('primary')} onClick={() => { showToast(`SMS renvoyé → ${res.phone}`); onClose() }}>Renvoyer SMS</button>
      </div>
    </div>
  )
}

// ─── EDIT SLOT MODAL ──────────────────────────────────────────────────────────
function EditSlotModal({ dateStr, time, slot, progs, saveProgs, onClose, showToast }) {
  const [type, setType] = useState(slot.type)
  const [label, setLabel] = useState(slot.label||'')
  function save() {
    const prog = [...(progs[dateStr]||[])]
    const idx = prog.findIndex(p=>p.time===time)
    if(idx>=0) prog[idx]={...prog[idx],type,label}
    saveProgs({...progs,[dateStr]:prog})
    showToast('Créneau modifié')
    onClose()
  }
  function del() {
    if(!window.confirm('Supprimer ce créneau ? Les réservations restent.'))return
    saveProgs({...progs,[dateStr]:(progs[dateStr]||[]).filter(p=>p.time!==time)})
    showToast('Créneau supprimé')
    onClose()
  }
  return (
    <div style={S.modal}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}><h3 style={{ fontSize:15, fontWeight:600 }}>Modifier le créneau</h3><button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#9ca3af' }}>✕</button></div>
      <div style={{ fontSize:12, color:'#9ca3af', marginBottom:13 }}>{time}</div>
      <div style={S.field}><label style={S.fieldLabel}>Type</label>
        <select style={S.input} value={type} onChange={e=>setType(e.target.value)}>
          <option value="adulte">Adulte</option>
          <option value="enfant">Enfant</option>
          <option value="event">Événement bloquant</option>
        </select>
      </div>
      {type==='event' && <div style={S.field}><label style={S.fieldLabel}>Nom de l'événement</label><input style={S.input} value={label} onChange={e=>setLabel(e.target.value)} placeholder="Relâche essence, Trophée..." /></div>}
      <div style={{ fontSize:11, color:'#9ca3af', marginBottom:12 }}>⚠️ Les réservations existantes sont conservées.</div>
      <div style={{ display:'flex', gap:6, justifyContent:'flex-end' }}>
        <button style={S.btn('danger')} onClick={del}>Supprimer</button>
        <button style={S.btn()} onClick={onClose}>Annuler</button>
        <button style={S.btn('primary')} onClick={save}>Enregistrer</button>
      </div>
    </div>
  )
}

// ─── ADD EVENT MODAL ──────────────────────────────────────────────────────────
function AddEventModal({ dateStr, progs, saveProgs, onClose, showToast }) {
  const [time, setTime] = useState('12:00')
  const [type, setType] = useState('event')
  const [label, setLabel] = useState('Relâche essence')
  function save() {
    const prog = [...(progs[dateStr]||[])]
    prog.push({ id:'e'+Date.now(), type, time, label })
    saveProgs({...progs,[dateStr]:prog})
    showToast('Ajouté au programme')
    onClose()
  }
  return (
    <div style={S.modal}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}><h3 style={{ fontSize:15, fontWeight:600 }}>Ajouter au programme</h3><button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#9ca3af' }}>✕</button></div>
      <div style={{ fontSize:12, color:'#9ca3af', marginBottom:13 }}>Sera ajouté au programme d'aujourd'hui uniquement</div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:9 }}>
        <div style={S.field}><label style={S.fieldLabel}>Heure</label><input style={S.input} type="time" value={time} onChange={e=>setTime(e.target.value)} /></div>
        <div style={S.field}><label style={S.fieldLabel}>Type</label>
          <select style={S.input} value={type} onChange={e=>setType(e.target.value)}>
            <option value="event">Événement bloquant</option>
            <option value="adulte">Créneau Adulte</option>
            <option value="enfant">Créneau Enfant</option>
          </select>
        </div>
      </div>
      {type==='event' && <div style={S.field}><label style={S.fieldLabel}>Nom</label><input style={S.input} value={label} onChange={e=>setLabel(e.target.value)} placeholder="Relâche essence, Trophée, Ne rien prendre..." /></div>}
      <div style={{ display:'flex', gap:6, justifyContent:'flex-end' }}>
        <button style={S.btn()} onClick={onClose}>Annuler</button>
        <button style={S.btn('primary')} onClick={save}>Ajouter</button>
      </div>
    </div>
  )
}

// ─── CONFIG MODAL ─────────────────────────────────────────────────────────────
function ConfigModal({ cfg, onSave, onClose, showToast }) {
  const [form, setForm] = useState(JSON.parse(JSON.stringify(cfg)))
  function save() { onSave(form); onClose(); showToast('Configuration enregistrée') }
  function updSess(id, field, val) { setForm(f=>({...f,sessions:f.sessions.map(s=>s.id===id?{...s,[field]:val}:s)})) }
  function addSess() {
    const colors=['#1D9E75','#BA7517','#E24B4A','#7F77DD','#378ADD']
    const bgs=['#E1F5EE','#FAEEDA','#FCEBEB','#EEEDFE','#E6F1FB']
    const i = form.sessions.length % 5
    setForm(f=>({...f,sessions:[...f.sessions,{id:'s'+Date.now(),label:'Nouvelle session',dur:15,price:20,deposit:5,color:colors[i],bg:bgs[i]}]}))
  }
  function rmSess(id) { if(form.sessions.length<=1){alert('Min 1 session.');return} setForm(f=>({...f,sessions:f.sessions.filter(s=>s.id!==id)})) }
  return (
    <div style={{ ...S.modal, width:'min(500px,96vw)' }}>
      <div style={{ display:'flex', justifyContent:'space-between', marginBottom:16 }}><h3 style={{ fontSize:15, fontWeight:600 }}>Configuration</h3><button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#9ca3af' }}>✕</button></div>
      {[['Informations',[['Nom',<input style={S.input} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} />],['Ville',<input style={S.input} value={form.city} onChange={e=>setForm(f=>({...f,city:e.target.value}))} />]]],
        ['Horaires et capacité',[['Ouverture (h)',<input style={S.input} type="number" min="0" max="23" value={form.open_hour} onChange={e=>setForm(f=>({...f,open_hour:parseInt(e.target.value)}))} />],['Fermeture (h)',<input style={S.input} type="number" min="1" max="24" value={form.close_hour} onChange={e=>setForm(f=>({...f,close_hour:parseInt(e.target.value)}))} />],['Karts adulte',<input style={S.input} type="number" min="1" value={form.kart_adulte} onChange={e=>setForm(f=>({...f,kart_adulte:parseInt(e.target.value)}))} />],['Karts enfant',<input style={S.input} type="number" min="1" value={form.kart_enfant} onChange={e=>setForm(f=>({...f,kart_enfant:parseInt(e.target.value)}))} />]]]
      ].map(([title, fields]) => (
        <div key={title} style={{ marginBottom:18 }}>
          <div style={{ fontSize:13, fontWeight:500, marginBottom:8, paddingBottom:5, borderBottom:'1px solid #f3f4f6' }}>{title}</div>
          <div style={{ display:'grid', gridTemplateColumns:`repeat(${fields.length<=2?2:4},1fr)`, gap:8 }}>
            {fields.map(([l,el]) => <div key={l} style={S.field}><label style={S.fieldLabel}>{l}</label>{el}</div>)}
          </div>
        </div>
      ))}
      <div style={{ marginBottom:18 }}>
        <div style={{ fontSize:13, fontWeight:500, marginBottom:8, paddingBottom:5, borderBottom:'1px solid #f3f4f6' }}>Sessions</div>
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
        <button onClick={addSess} style={{ background:'none', border:'1px dashed #e5e7eb', borderRadius:7, padding:'7px', width:'100%', fontSize:12, color:'#9ca3af', cursor:'pointer' }}>+ Ajouter une session</button>
      </div>
      <div style={{ marginBottom:16 }}>
        <div style={{ fontSize:13, fontWeight:500, marginBottom:8, paddingBottom:5, borderBottom:'1px solid #f3f4f6' }}>Message SMS / Email</div>
        <div style={{ fontSize:11, color:'#9ca3af', marginBottom:5 }}>Variables : {'{nom} {karting} {date} {heure} {session} {duree} {participants} {total} {acompte} {lien}'}</div>
        <textarea style={{ ...S.input, height:70, resize:'vertical' }} value={form.sms} onChange={e=>setForm(f=>({...f,sms:e.target.value}))} />
      </div>
      <div style={{ display:'flex', gap:6, justifyContent:'flex-end' }}>
        <button style={S.btn()} onClick={()=>{if(window.confirm('Réinitialiser ?')){setForm(JSON.parse(JSON.stringify(DEFAULT_CFG)))}}}>Réinitialiser</button>
        <button style={S.btn('primary')} onClick={save}>Enregistrer</button>
      </div>
    </div>
  )
}
