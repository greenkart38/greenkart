import { useState, useEffect, useRef } from 'react'
import { supabase } from './supabase'

// ─── CONSTANTES ───────────────────────────────────────────────────────────────
const DAYS = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim']
const MONTHS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre']
const MS = ['Jan','Fév','Mar','Avr','Mai','Jun','Jul','Aoû','Sep','Oct','Nov','Déc']

const HORAIRES_BASE = {
  0: null,      // Lundi fermé
  1: null,      // Mardi fermé
  2: [14, 22],  // Mercredi
  3: [16, 22],  // Jeudi
  4: [16, 22],  // Vendredi
  5: [14, 22],  // Samedi
  6: [14, 20],  // Dimanche
}
const HORAIRES_VACANCES = [14, 22]
const ENFANT_MAX_HOUR = 18

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function fmtDate(d) { return d.toISOString().split('T')[0] }
function todayStr() { return fmtDate(new Date()) }

function getWeekStart(d) {
  const nd = new Date(d); const day = nd.getDay()
  nd.setDate(nd.getDate() + (day === 0 ? -6 : 1 - day)); return nd
}
function getWeekDays(d) {
  const ws = getWeekStart(d)
  return Array.from({ length: 7 }, (_, i) => { const dd = new Date(ws); dd.setDate(ws.getDate() + i); return dd })
}
function isVacances(dateStr, vacances = []) { return (vacances||[]).some(v => dateStr >= v.start && dateStr <= v.end) }
function getHoraires(dateStr, cfg) {
  const exc = (cfg.jours_exceptionnels||[]).find(j => j.date === dateStr)
  if (exc) return [exc.open, exc.close]
  if (isVacances(dateStr, cfg.vacances)) return HORAIRES_VACANCES
  const d = new Date(dateStr + 'T12:00:00')
  const dow = d.getDay()
  const idx = dow === 0 ? 6 : dow - 1
  return HORAIRES_BASE[idx] || null
}
function getAllSlots(open, close) {
  const s = []
  for (let h = open; h < close; h++)
    for (let m = 0; m < 60; m += 15)
      s.push(`${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`)
  return s
}
function isPause(time) {
  if (time === '19:00') return '⛽ Essence'
  if (time === '20:00') return '🍽️ Miam'
  if (time.endsWith(':00')) return '⏸ Pause'
  return null
}

// Génère les créneaux intercalés adulte/enfant
// Adulte en premier, puis enfant, en alternance, en sautant les pauses
function generateInterleavedSlots(startTime, nbAdulte, nbEnfant, allSlots) {
  const startIdx = allSlots.indexOf(startTime)
  if (startIdx < 0) return { adulteSlots: [], enfantSlots: [] }

  const adulteSlots = []
  const enfantSlots = []
  let idx = startIdx
  // Alterner : A, E, A, E... jusqu'à avoir assez des deux
  // Si un des deux est 0, on saute son tour
  let aLeft = nbAdulte
  let eLeft = nbEnfant
  let turn = 'adulte' // commence toujours par adulte

  while ((aLeft > 0 || eLeft > 0) && idx < allSlots.length) {
    // Sauter les pauses
    while (idx < allSlots.length && isPause(allSlots[idx])) idx++
    if (idx >= allSlots.length) break

    const slot = allSlots[idx]

    if (turn === 'adulte') {
      if (aLeft > 0) {
        adulteSlots.push(slot)
        aLeft--
        idx++
        turn = eLeft > 0 ? 'enfant' : 'adulte'
      } else {
        turn = 'enfant'
      }
    } else {
      // enfant — vérifier limite 18h
      if (eLeft > 0 && slot < `${String(ENFANT_MAX_HOUR).padStart(2,'0')}:00`) {
        enfantSlots.push(slot)
        eLeft--
        idx++
        turn = aLeft > 0 ? 'adulte' : 'enfant'
      } else {
        // Dépasse 18h ou plus d'enfants, mettre adulte à la place
        if (aLeft > 0) {
          adulteSlots.push(slot)
          aLeft--
          idx++
        }
        eLeft = 0 // abandon enfants après 18h
      }
    }
  }

  return { adulteSlots, enfantSlots }
}

// SMS via fonction Vercel (contourne CORS)
async function sendSMS(phone, message) {
  try {
    const resp = await fetch('/api/send-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone.replace(/\s/g, ''), message }),
    })
    const data = await resp.json()
    return { ok: resp.ok, data }
  } catch(e) {
    return { ok: false, error: e.message }
  }
}

function buildSMS(cfg, name, date, time, session, participants, depositLink) {
  return (cfg.sms || '')
    .replace('{nom}', name)
    .replace('{karting}', cfg.name + ' ' + cfg.city)
    .replace('{date}', new Date(date + 'T12:00:00').toLocaleDateString('fr-FR'))
    .replace('{heure}', time)
    .replace('{session}', session?.label || '')
    .replace('{participants}', participants)
    .replace('{acompte}', session?.deposit || '')
    .replace('{lien}', depositLink)
}

const DEFAULT_CFG = {
  name: 'Green Kart', city: 'Échirolles',
  kart_adulte: 15, kart_enfant: 12,
  sms: 'Bonjour {nom} ! Résa confirmée au {karting}.\n{date} à {heure} · {session} · {participants} pers.\nAcompte {acompte}€ : {lien}',
  sessions: [
    { id:'s1', label:'ADULTES', price:25, deposit:8, color:'#1D9E75', bg:'#E1F5EE' },
    { id:'s2', label:'ENFANTS', price:18, deposit:6, color:'#BA7517', bg:'#FAEEDA' },
  ],
  vacances: [], jours_exceptionnels: [],
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  app: { fontFamily:'"DM Sans",-apple-system,BlinkMacSystemFont,sans-serif', color:'#1a1a1a', background:'#f7f8fa', minHeight:'100vh', padding:'0 16px 60px' },
  topbar: { display:'flex', alignItems:'center', gap:8, padding:'12px 0 10px', borderBottom:'1px solid #e5e7eb', flexWrap:'wrap' },
  brand: { fontSize:15, fontWeight:700, color:'#111' },
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
}

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [cfg, setCfg] = useState(() => { try { return {...DEFAULT_CFG,...JSON.parse(localStorage.getItem('gk_cfg')||'{}')} } catch { return DEFAULT_CFG } })
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
      .on('postgres_changes', { event:'*', schema:'public', table:'reservations' }, () => fetchRes())
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [])

  async function fetchRes() {
    const { data } = await supabase.from('reservations').select('*').order('date').order('time')
    if (data) setReservations(data)
    setLoading(false)
  }

  function saveCfg(c) { setCfg(c); try { localStorage.setItem('gk_cfg', JSON.stringify(c)) } catch {} }

  function showToast(msg, type='ok') {
    setToast({msg, type})
    clearTimeout(toastRef.current)
    toastRef.current = setTimeout(() => setToast(null), 5000)
  }

  function nav(dir) {
    const d = new Date(curDate); d.setDate(d.getDate() + dir*(view==='semaine'?7:1)); setCurDate(d)
  }

  const days = view==='semaine' ? getWeekDays(curDate) : [curDate]
  const ts = todayStr()

  // ─── CRUD ─────────────────────────────────────────────────────────────────
  async function saveReservation(items) {
    const firstId = Date.now().toString(36) + Math.random().toString(36).substr(2,5)
    const newRes = []

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const id = i === 0 ? firstId : Date.now().toString(36) + Math.random().toString(36).substr(2,5)
      const depositLink = `https://pay.greenkart.fr/${firstId}`
      const { error } = await supabase.from('reservations').insert({
        id, date:item.dateStr, time:item.time,
        name:item.name, phone:item.phone, email:item.email||null,
        session:item.session, participants:item.participants,
        kart_type:item.kart_type, notes:item.notes||null,
        deposit_link: depositLink,
        arrived:false, acompte_paid:false,
      })
      if (error) { showToast('❌ Erreur : '+error.message, 'err'); return false }
      newRes.push({id, ...item})
    }

    // Mise à jour locale immédiate
    setReservations(prev => [...prev, ...newRes.map((item,i) => ({
      id: item.id, date:item.dateStr, time:item.time,
      name:item.name, phone:item.phone, email:item.email||null,
      session:item.session, participants:item.participants,
      kart_type:item.kart_type, notes:item.notes||null,
      deposit_link:`https://pay.greenkart.fr/${firstId}`,
      arrived:false, acompte_paid:false,
    }))])

    // SMS — 1 seul SMS récap
    const first = items[0]
    const session = cfg.sessions.find(x=>x.id===first.session) || cfg.sessions[0]
    const msg = buildSMS(cfg, first.name, first.dateStr, first.time, session, first.participants, `https://pay.greenkart.fr/${firstId}`)
      + (items.length > 1 ? `\n${items.length} créneaux réservés.` : '')
    const smsRes = await sendSMS(first.phone, msg)

    setModal(null)
    if (smsRes.ok) {
      showToast(`✓ ${items.length > 1 ? items.length+' réservations créées' : 'Réservation confirmée'} · 📱 SMS envoyé`)
    } else {
      showToast(`✓ Réservation${items.length>1?'s':''} créée${items.length>1?'s':''} · ⚠️ SMS échoué`)
    }
    return true
  }

  async function toggleArrived(id) {
    const r = reservations.find(x => x.id===id); if (!r) return
    const linked = reservations.filter(x => x.name===r.name && x.phone===r.phone && x.date===r.date)
    const newVal = !r.arrived
    // Mise à jour locale immédiate
    setReservations(prev => prev.map(x => linked.find(l=>l.id===x.id) ? {...x, arrived:newVal} : x))
    // Sync Supabase
    for (const lr of linked) await supabase.from('reservations').update({arrived:newVal}).eq('id',lr.id)
    showToast(newVal ? `✓ ${r.name} arrivé${linked.length>1?` (${linked.length} sessions)`:''}` : `${r.name} remis en attente`)
  }

  async function toggleAcompte(id) {
    const r = reservations.find(x => x.id===id); if (!r) return
    const newVal = !r.acompte_paid
    // Mise à jour locale immédiate
    setReservations(prev => prev.map(x => x.id===id ? {...x, acompte_paid:newVal} : x))
    // Sync Supabase
    await supabase.from('reservations').update({acompte_paid:newVal}).eq('id',id)
    showToast(newVal ? '💳 Acompte reçu' : 'Acompte annulé')
  }

  async function deleteRes(id) {
    if (!window.confirm('Supprimer cette réservation ?')) return
    setReservations(prev => prev.filter(x => x.id!==id))
    await supabase.from('reservations').delete().eq('id',id)
    setModal(null)
    showToast('Réservation supprimée')
  }

  async function updateRes(id, updates) {
    setReservations(prev => prev.map(x => x.id===id ? {...x,...updates} : x))
    const { error } = await supabase.from('reservations').update(updates).eq('id',id)
    if (error) { showToast('❌ '+error.message, 'err'); return }
    showToast('✓ Mis à jour')
  }

  async function resendSMS(res) {
    const session = cfg.sessions.find(x=>x.id===res.session) || cfg.sessions[0]
    const msg = buildSMS(cfg, res.name, res.date, res.time, session, res.participants, res.deposit_link)
    const r = await sendSMS(res.phone, msg)
    showToast(r.ok ? `📱 SMS renvoyé → ${res.phone}` : `❌ SMS échoué : ${r.error||''}`)
  }

  function getResAt(ds, time) { return reservations.filter(r => r.date===ds && r.time===time) }
  function getUsed(ds, time, kt) { return reservations.filter(r => r.date===ds && r.time===time && r.kart_type===kt).reduce((s,r) => s+(r.participants||1), 0) }
  function getRemaining(ds, time, kt) { return (kt==='adulte'?cfg.kart_adulte:cfg.kart_enfant) - getUsed(ds,time,kt) }

  if (loading) return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',minHeight:'100vh',flexDirection:'column',gap:16}}>
      <div style={{width:32,height:32,border:'3px solid #e5e7eb',borderTop:'3px solid #1D9E75',borderRadius:'50%',animation:'spin 1s linear infinite'}}/>
      <div style={{fontSize:13,color:'#9ca3af'}}>Chargement...</div>
    </div>
  )

  return (
    <div style={S.app}>
      {toast && (
        <div style={{position:'fixed',top:16,right:16,zIndex:2000,background:'#fff',border:'1px solid #e5e7eb',borderLeft:`3px solid ${toast.type==='err'?'#dc2626':'#1D9E75'}`,borderRadius:9,padding:'10px 14px',fontSize:13,boxShadow:'0 4px 20px rgba(0,0,0,0.1)',animation:'fadeIn 0.2s ease',maxWidth:340}}>
          {toast.msg}
        </div>
      )}

      <div style={S.topbar}>
        <div style={S.brand}>🏎️ {cfg.name} <span style={{fontSize:12,fontWeight:400,color:'#9ca3af'}}>{cfg.city}</span></div>
        <div style={S.tabs}>
          <button style={S.tab(tab==='cal')} onClick={()=>setTab('cal')}>📅 Calendrier</button>
          <button style={S.tab(tab==='today')} onClick={()=>setTab('today')}>🏁 Aujourd'hui</button>
          <button style={S.tab(tab==='events')} onClick={()=>setTab('events')}>🏆 Événements</button>
        </div>
        {tab==='cal' && (
          <div style={{display:'flex',gap:5,alignItems:'center'}}>
            <button style={S.btn()} onClick={()=>nav(-1)}>←</button>
            <span style={{fontSize:12,fontWeight:500,minWidth:145,textAlign:'center'}}>
              {view==='semaine'
                ? `${days[0].getDate()} ${MS[days[0].getMonth()]} — ${days[6].getDate()} ${MS[days[6].getMonth()]} ${days[6].getFullYear()}`
                : `${curDate.getDate()} ${MONTHS[curDate.getMonth()]} ${curDate.getFullYear()}`}
            </span>
            <button style={S.btn()} onClick={()=>nav(1)}>→</button>
            <button style={S.btn()} onClick={()=>setCurDate(new Date())}>Auj.</button>
            <button style={S.btn(view==='semaine'?'primary':'default')} onClick={()=>setView('semaine')}>Semaine</button>
            <button style={S.btn(view==='jour'?'primary':'default')} onClick={()=>setView('jour')}>Jour</button>
          </div>
        )}
        <button style={{...S.btn(),marginLeft:'auto'}} onClick={()=>setModal({type:'config'})}>⚙ Config</button>
      </div>

      <div style={{display:'flex',gap:8,marginTop:8,flexWrap:'wrap'}}>
        <div style={S.cap}><div style={S.capLabel}>Karts adulte</div><div style={{...S.capVal,color:'#1D9E75'}}>{cfg.kart_adulte} max</div></div>
        <div style={S.cap}><div style={S.capLabel}>Karts enfant</div><div style={{...S.capVal,color:'#BA7517'}}>{cfg.kart_enfant} max</div></div>
        <div style={{...S.cap,marginLeft:'auto'}}><div style={S.capLabel}>Réservations</div><div style={S.capVal}>{reservations.length}</div></div>
      </div>
      <div style={{display:'flex',gap:10,padding:'6px 0',borderBottom:'1px solid #e5e7eb',flexWrap:'wrap',fontSize:11,color:'#6b7280',marginTop:6}}>
        {cfg.sessions.map(s=><span key={s.id}><span style={{display:'inline-block',width:8,height:8,borderRadius:2,background:s.color,marginRight:4}}/>{s.label} {s.price}€</span>)}
        <span style={{color:'#d1d5db'}}>|</span>
        <span>⏸ Heures piles = pause · 🟢 A · 🟡 E (14h→18h)</span>
      </div>

      {tab==='cal' && <CalView days={days} view={view} cfg={cfg} reservations={reservations} ts={ts} setCurDate={setCurDate} setView={setView} setModal={setModal} getResAt={getResAt} getRemaining={getRemaining}/>}
      {tab==='today' && <TodayPage cfg={cfg} reservations={reservations} toggleArrived={toggleArrived} toggleAcompte={toggleAcompte} setModal={setModal}/>}
      {tab==='events' && <EventsPage cfg={cfg} reservations={reservations} saveReservation={saveReservation}/>}

      {modal && (
        <div style={S.overlay} onClick={()=>setModal(null)}>
          <div onClick={e=>e.stopPropagation()}>
            {modal.type==='new' && <NewResModal cfg={cfg} dateStr={modal.dateStr} time={modal.time} reservations={reservations} onSave={saveReservation} onClose={()=>setModal(null)}/>}
            {modal.type==='detail' && <DetailModal cfg={cfg} res={reservations.find(r=>r.id===modal.res.id)||modal.res} onToggleArrived={toggleArrived} onToggleAcompte={toggleAcompte} onDelete={deleteRes} onUpdate={updateRes} onResendSMS={resendSMS} onClose={()=>setModal(null)}/>}
            {modal.type==='config' && <ConfigModal cfg={cfg} onSave={saveCfg} onClose={()=>setModal(null)} showToast={showToast}/>}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── CAL VIEW ─────────────────────────────────────────────────────────────────
function CalView({days,view,cfg,reservations,ts,setCurDate,setView,setModal,getResAt,getRemaining}) {
  const slotsPerDay = days.map(d => { const ds=fmtDate(d); const h=getHoraires(ds,cfg); return h?getAllSlots(h[0],h[1]):[] })
  const allTimes = [...new Set(slotsPerDay.flat())].sort()

  return (
    <div style={{overflowX:'auto',marginTop:0}}>
      <div style={{display:'grid',gridTemplateColumns:`52px repeat(${days.length}, minmax(${view==='jour'?'440px':'100px'},1fr))`,minWidth:view==='jour'?492:740}}>
        <div style={{borderBottom:'1px solid #e5e7eb',position:'sticky',top:0,background:'#f7f8fa',zIndex:10}}/>
        {days.map((d,i) => {
          const ds=fmtDate(d), isT=ds===ts, h=getHoraires(ds,cfg)
          const totalRes=reservations.filter(r=>r.date===ds).length
          return (
            <div key={i} onClick={()=>{if(view==='semaine'){setCurDate(new Date(ds+'T12:00:00'));setView('jour')}}}
              style={{fontSize:11,color:isT?'#1D9E75':'#9ca3af',padding:'7px 3px 5px',textAlign:'center',borderBottom:'1px solid #e5e7eb',borderLeft:'1px solid #f0f1f3',position:'sticky',top:0,background:'#f7f8fa',zIndex:10,cursor:'pointer'}}>
              <div>{DAYS[i%7]}</div>
              <div style={{fontSize:18,fontWeight:700,color:isT?'#1D9E75':h?'#111':'#d1d5db',lineHeight:1.1}}>{d.getDate()}</div>
              {isVacances(ds,cfg.vacances)&&<div style={{fontSize:8,color:'#7F77DD',fontWeight:700}}>VAC</div>}
              {!h&&!isVacances(ds,cfg.vacances)&&<div style={{fontSize:8,color:'#d1d5db'}}>fermé</div>}
              {totalRes>0&&<div style={{fontSize:9,color:'#1D9E75',fontWeight:600}}>{totalRes} résa</div>}
            </div>
          )
        })}
        {allTimes.map(time => {
          const isH=time.endsWith(':00'), pause=isPause(time)
          return [
            <div key={`t-${time}`} style={{fontSize:10,color:isH?'#9ca3af':'transparent',textAlign:'right',paddingRight:5,display:'flex',alignItems:'flex-start',justifyContent:'flex-end',paddingTop:2,borderBottom:`1px solid ${isH?'#e5e7eb':'#f3f4f6'}`,height:38}}>{time}</div>,
            ...days.map((day,di) => {
              const ds=fmtDate(day), inRange=slotsPerDay[di].includes(time)
              const sr=getResAt(ds,time)
              const remA=getRemaining(ds,time,'adulte'), remE=getRemaining(ds,time,'enfant')
              return (
                <div key={`s-${time}-${di}`}
                  onClick={()=>inRange&&!pause&&setModal({type:'new',dateStr:ds,time})}
                  style={{height:38,borderBottom:`1px solid ${isH?'#e5e7eb':'#f3f4f6'}`,borderLeft:'1px solid #f0f1f3',background:!inRange?'#fafafa':pause?'#FFFBEB':'#fff',position:'relative',cursor:(!inRange||pause)?'default':'pointer'}}
                  onMouseEnter={e=>{if(inRange&&!pause)e.currentTarget.style.background='#f0faf5'}}
                  onMouseLeave={e=>{e.currentTarget.style.background=!inRange?'#fafafa':pause?'#FFFBEB':'#fff'}}
                >
                  {!inRange&&<div style={{position:'absolute',inset:0,background:'repeating-linear-gradient(45deg,transparent,transparent 4px,#f3f4f6 4px,#f3f4f6 5px)'}}/>}
                  {pause&&inRange&&<div style={{position:'absolute',inset:'2px 2px',borderRadius:3,background:'#FEF3C7',display:'flex',alignItems:'center',padding:'0 6px',fontSize:9,fontWeight:700,color:'#92400E'}}>{pause}</div>}
                  {!pause&&inRange&&(
                    <>
                      {sr.map((r,ri) => {
                        const s=cfg.sessions.find(x=>x.id===r.session)
                        const w=100/Math.max(sr.length,1)
                        return (
                          <div key={r.id} onClick={e=>{e.stopPropagation();setModal({type:'detail',res:r})}}
                            style={{position:'absolute',top:2,bottom:2,left:`${ri*w}%`,width:`calc(${w}% - 3px)`,background:r.arrived?'#D1FAE5':s?s.bg:'#f3f4f6',border:`1px solid ${r.arrived?'#059669':s?s.color:'#e5e7eb'}`,borderRadius:3,padding:'0 4px',fontSize:9,fontWeight:600,color:r.arrived?'#065F46':s?s.color:'#374151',overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis',display:'flex',alignItems:'center',gap:2,cursor:'pointer'}}>
                            {r.arrived?'✓ ':''}{r.name}·{r.participants}p
                          </div>
                        )
                      })}
                      <div style={{position:'absolute',bottom:1,right:2,display:'flex',gap:2,pointerEvents:'none'}}>
                        <span style={{fontSize:8,background:'#E1F5EE',color:'#0F6E56',padding:'1px 4px',borderRadius:3,fontWeight:700}}>A:{remA}</span>
                        <span style={{fontSize:8,background:'#FAEEDA',color:'#854F0B',padding:'1px 4px',borderRadius:3,fontWeight:700}}>E:{remE}</span>
                      </div>
                    </>
                  )}
                </div>
              )
            })
          ]
        })}
      </div>
      <div style={{display:'flex',gap:14,padding:'7px 0',borderTop:'1px solid #e5e7eb',fontSize:12,color:'#9ca3af',marginTop:4}}>
        <span>Adulte : {reservations.reduce((s,r)=>r.kart_type==='adulte'?s+r.participants:s,0)} karts</span>
        <span>Enfant : {reservations.reduce((s,r)=>r.kart_type==='enfant'?s+r.participants:s,0)} karts</span>
        <span style={{marginLeft:'auto'}}>● en direct</span>
      </div>
    </div>
  )
}

// ─── TODAY PAGE ───────────────────────────────────────────────────────────────
function TodayPage({cfg,reservations,toggleArrived,toggleAcompte,setModal}) {
  const ts=todayStr()
  const h=getHoraires(ts,cfg)
  const allSlots=h?getAllSlots(h[0],h[1]):[]
  const todayRes=reservations.filter(r=>r.date===ts)
  const arrived=todayRes.filter(r=>r.arrived).length
  const acomptes=todayRes.filter(r=>r.acompte_paid).length
  const allTimes=[...new Set([...allSlots,...todayRes.map(r=>r.time)])].sort()

  return (
    <div style={{paddingTop:14}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:14,flexWrap:'wrap',gap:8}}>
        <div>
          <div style={{fontSize:16,fontWeight:700}}>Aujourd'hui</div>
          <div style={{fontSize:12,color:'#9ca3af'}}>{new Date().toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</div>
        </div>
        <div style={{display:'flex',gap:7,flexWrap:'wrap'}}>
          {[['Total',todayRes.length,'#111'],['Arrivés',arrived,'#1D9E75'],['En attente',todayRes.length-arrived,'#dc2626'],['Acomptes',acomptes,'#1D9E75']].map(([l,v,c])=>(
            <div key={l} style={{background:'#fff',border:'1px solid #e5e7eb',borderRadius:9,padding:'6px 12px',textAlign:'center'}}>
              <div style={{fontSize:17,fontWeight:700,color:c}}>{v}</div>
              <div style={{fontSize:11,color:'#9ca3af'}}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {allTimes.length===0&&<div style={{textAlign:'center',padding:'40px 0',color:'#9ca3af',fontSize:13}}>Aucun créneau aujourd'hui</div>}

      {allTimes.map(time => {
        const pause=allSlots.includes(time)?isPause(time):null
        const inRange=allSlots.includes(time)
        const slotRes=todayRes.filter(r=>r.time===time)
        return (
          <div key={time} style={{marginBottom:8}}>
            {/* Header créneau */}
            <div style={{display:'flex',alignItems:'center',gap:8,padding:'6px 10px',border:`1px solid ${pause?'#FCD34D':'#e5e7eb'}`,borderRadius:8,marginBottom:3,background:pause?'#FFFBEB':'#f9fafb'}}>
              <span style={{fontSize:13,fontWeight:700,minWidth:44,color:pause?'#92400E':'#6b7280'}}>{time}</span>
              {pause&&<span style={{fontSize:11,fontWeight:700,color:'#92400E'}}>{pause} — pause</span>}
              {!inRange&&<span style={{fontSize:10,color:'#9ca3af',fontStyle:'italic'}}>hors horaires</span>}
              {!pause&&inRange&&<button style={{...S.btn('primary'),marginLeft:'auto'}} onClick={()=>setModal({type:'new',dateStr:ts,time})}>+ Résa</button>}
            </div>

            {/* Réservations — rouge si pas arrivé, vert si arrivé */}
            {slotRes.map(r => {
              const s=cfg.sessions.find(x=>x.id===r.session)
              return (
                <div key={r.id} style={{display:'flex',alignItems:'center',gap:8,padding:'9px 11px',border:`2px solid ${r.arrived?'#059669':'#fca5a5'}`,borderRadius:9,marginBottom:5,marginLeft:16,background:r.arrived?'#f0fdf4':'#fff8f8',transition:'all 0.2s'}}>
                  {/* Bouton arrivée */}
                  <div onClick={()=>toggleArrived(r.id)}
                    style={{width:28,height:28,borderRadius:'50%',border:`2px solid ${r.arrived?'#059669':'#ef4444'}`,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',fontSize:14,background:r.arrived?'#059669':'#fff',color:r.arrived?'#fff':'#ef4444',flexShrink:0,transition:'all 0.2s',fontWeight:700}}>
                    {r.arrived?'✓':'!'}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:600,textDecoration:r.arrived?'line-through':'none',color:r.arrived?'#6b7280':'#111'}}>{r.name}</div>
                    <div style={{fontSize:11,color:'#9ca3af',marginTop:1,display:'flex',gap:5,flexWrap:'wrap',alignItems:'center'}}>
                      <span style={S.badge(s?s.bg:'#f3f4f6',s?s.color:'#374151')}>{s?.label||'?'}</span>
                      <span style={S.badge(r.kart_type==='adulte'?'#E1F5EE':'#FAEEDA',r.kart_type==='adulte'?'#0F6E56':'#854F0B')}>{r.kart_type}</span>
                      {r.participants} pers · {r.phone}
                    </div>
                    {r.notes&&<div style={{fontSize:10,color:'#9ca3af',marginTop:1}}>📝 {r.notes}</div>}
                  </div>
                  <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:5,flexShrink:0}}>
                    {/* Bouton acompte */}
                    <button onClick={()=>toggleAcompte(r.id)}
                      style={{fontSize:11,padding:'4px 10px',borderRadius:20,border:`2px solid ${r.acompte_paid?'#059669':'#e5e7eb'}`,cursor:'pointer',background:r.acompte_paid?'#059669':'#fff',color:r.acompte_paid?'#fff':'#9ca3af',fontWeight:600,transition:'all 0.2s',whiteSpace:'nowrap'}}>
                      {r.acompte_paid?'✓ Acompte reçu':`Acompte ${s?.deposit||'?'}€`}
                    </button>
                    <button style={S.btn()} onClick={()=>setModal({type:'detail',res:r})}>Détails</button>
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
function NewResModal({cfg,dateStr,time,reservations,onSave,onClose}) {
  const [selDate,setSelDate]=useState(dateStr)
  const [selTime,setSelTime]=useState(time)
  const h=getHoraires(selDate,cfg)
  const allSlots=h?getAllSlots(h[0],h[1]):[]

  const [form,setForm]=useState({
    name:'',phone:'',email:'',notes:'',
    adulteEnabled:true, adulteNbSessions:1, adulteParticipants:1,
    enfantEnabled:false, enfantNbSessions:1, enfantParticipants:1,
  })

  const sAdulte=cfg.sessions.find(x=>x.label?.toUpperCase().includes('ADULTE'))||cfg.sessions[0]
  const sEnfant=cfg.sessions.find(x=>x.label?.toUpperCase().includes('ENFANT'))||cfg.sessions[1]||cfg.sessions[0]

  const {adulteSlots,enfantSlots}=generateInterleavedSlots(
    selTime,
    form.adulteEnabled ? form.adulteNbSessions : 0,
    form.enfantEnabled ? form.enfantNbSessions : 0,
    allSlots
  )
  const previewSlots=[...new Set([...adulteSlots,...enfantSlots])].sort()

  function getRemaining(t,kt) {
    const max=kt==='adulte'?cfg.kart_adulte:cfg.kart_enfant
    const used=reservations.filter(r=>r.date===selDate&&r.time===t&&r.kart_type===kt).reduce((s,r)=>s+r.participants,0)
    return max-used
  }

  function buildItems() {
    const items=[]
    for (const t of adulteSlots) items.push({dateStr:selDate,time:t,name:form.name,phone:form.phone,email:form.email,session:sAdulte?.id,participants:form.adulteParticipants,kart_type:'adulte',notes:form.notes})
    for (const t of enfantSlots) items.push({dateStr:selDate,time:t,name:form.name,phone:form.phone,email:form.email,session:sEnfant?.id,participants:form.enfantParticipants,kart_type:'enfant',notes:form.notes})
    return items
  }

  function handleSave() {
    if (!form.name.trim()||!form.phone.trim()) {alert('Nom et téléphone obligatoires.');return}
    if (!form.adulteEnabled&&!form.enfantEnabled) {alert('Sélectionnez au moins un type.');return}
    const items=buildItems()
    if (items.length===0) {alert('Aucun créneau disponible.');return}
    for (const item of items) {
      const rem=getRemaining(item.time,item.kart_type)
      if (item.participants>rem) {alert(`Capacité dépassée ${item.kart_type} à ${item.time} (${rem} dispo)`);return}
    }
    onSave(items)
  }

  const d=new Date(selDate+'T12:00:00')

  return (
    <div style={S.modal}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
        <h3 style={{fontSize:15,fontWeight:700}}>Nouvelle réservation</h3>
        <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',fontSize:18,color:'#9ca3af'}}>✕</button>
      </div>

      {/* Date + Heure modifiables */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:9,marginBottom:14,padding:'10px 12px',background:'#f9fafb',borderRadius:9,border:'1px solid #e5e7eb'}}>
        <div><label style={S.lbl}>📅 Date</label><input style={S.input} type="date" value={selDate} onChange={e=>setSelDate(e.target.value)}/></div>
        <div><label style={S.lbl}>🕐 Heure de début</label><input style={S.input} type="time" value={selTime} onChange={e=>setSelTime(e.target.value)}/></div>
      </div>

      {/* Bloc Adulte */}
      <div style={{border:`2px solid ${form.adulteEnabled?'#1D9E75':'#e5e7eb'}`,borderRadius:10,padding:'10px 12px',marginBottom:10,background:form.adulteEnabled?'#f0faf5':'#fafafa',transition:'all 0.15s'}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:form.adulteEnabled?10:0}}>
          <input type="checkbox" id="adulteOn" checked={form.adulteEnabled} onChange={e=>setForm(f=>({...f,adulteEnabled:e.target.checked}))} style={{width:16,height:16,accentColor:'#1D9E75'}}/>
          <label htmlFor="adulteOn" style={{fontSize:13,fontWeight:700,color:'#1D9E75',cursor:'pointer'}}>🟢 Adulte</label>
          {sAdulte&&<span style={{fontSize:11,color:'#9ca3af',marginLeft:'auto'}}>{sAdulte.price}€/pers</span>}
        </div>
        {form.adulteEnabled&&(
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
            <div><label style={S.lbl}>Nb sessions</label><input style={S.input} type="number" min={1} max={10} value={form.adulteNbSessions} onChange={e=>setForm(f=>({...f,adulteNbSessions:Math.max(1,parseInt(e.target.value)||1)}))}/></div>
            <div><label style={S.lbl}>Participants</label><input style={S.input} type="number" min={1} max={cfg.kart_adulte} value={form.adulteParticipants} onChange={e=>setForm(f=>({...f,adulteParticipants:Math.max(1,parseInt(e.target.value)||1)}))}/></div>
          </div>
        )}
      </div>

      {/* Bloc Enfant */}
      <div style={{border:`2px solid ${form.enfantEnabled?'#BA7517':'#e5e7eb'}`,borderRadius:10,padding:'10px 12px',marginBottom:14,background:form.enfantEnabled?'#fffbf0':'#fafafa',transition:'all 0.15s'}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:form.enfantEnabled?10:0}}>
          <input type="checkbox" id="enfantOn" checked={form.enfantEnabled} onChange={e=>setForm(f=>({...f,enfantEnabled:e.target.checked}))} style={{width:16,height:16,accentColor:'#BA7517'}}/>
          <label htmlFor="enfantOn" style={{fontSize:13,fontWeight:700,color:'#BA7517',cursor:'pointer'}}>🟡 Enfant <span style={{fontSize:10,fontWeight:400,color:'#9ca3af'}}>(jusqu'à 18h)</span></label>
          {sEnfant&&<span style={{fontSize:11,color:'#9ca3af',marginLeft:'auto'}}>{sEnfant.price}€/pers</span>}
        </div>
        {form.enfantEnabled&&(
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
            <div><label style={S.lbl}>Nb sessions</label><input style={S.input} type="number" min={1} max={10} value={form.enfantNbSessions} onChange={e=>setForm(f=>({...f,enfantNbSessions:Math.max(1,parseInt(e.target.value)||1)}))}/></div>
            <div><label style={S.lbl}>Participants</label><input style={S.input} type="number" min={1} max={cfg.kart_enfant} value={form.enfantParticipants} onChange={e=>setForm(f=>({...f,enfantParticipants:Math.max(1,parseInt(e.target.value)||1)}))}/></div>
          </div>
        )}
      </div>

      {/* Aperçu planning intercalé */}
      {previewSlots.length>0&&(
        <div style={{background:'#f9fafb',borderRadius:9,padding:'10px 12px',marginBottom:14,border:'1px solid #e5e7eb'}}>
          <div style={{fontSize:10,fontWeight:700,color:'#9ca3af',marginBottom:8,textTransform:'uppercase',letterSpacing:'0.5px'}}>📅 Aperçu planning intercalé</div>
          {previewSlots.map(t=>{
            const isA=adulteSlots.includes(t), isE=enfantSlots.includes(t)
            const remA=getRemaining(t,'adulte'), remE=getRemaining(t,'enfant')
            const existing=reservations.filter(r=>r.date===selDate&&r.time===t)
            const overA=isA&&form.adulteParticipants>remA
            const overE=isE&&form.enfantParticipants>remE
            return (
              <div key={t} style={{display:'flex',alignItems:'center',gap:6,fontSize:12,marginBottom:5,padding:'5px 8px',borderRadius:7,background:'#fff',border:`1px solid ${overA||overE?'#fca5a5':'#e5e7eb'}`}}>
                <span style={{fontWeight:700,color:'#1D9E75',minWidth:42}}>{t}</span>
                <div style={{display:'flex',gap:4,flex:1,flexWrap:'wrap'}}>
                  {isA&&<span style={S.badge(overA?'#FCEBEB':'#E1F5EE',overA?'#dc2626':'#0F6E56')}>🟢 {form.adulteParticipants}p · {remA} libre{overA?' ⚠️':''}</span>}
                  {isE&&<span style={S.badge(overE?'#FCEBEB':'#FAEEDA',overE?'#dc2626':'#854F0B')}>🟡 {form.enfantParticipants}p · {remE} libre{overE?' ⚠️':''}</span>}
                  {existing.map(r=><span key={r.id} style={S.badge('#f3f4f6','#6b7280')}>{r.name}</span>)}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Client */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:9}}>
        <div style={S.field}><label style={S.lbl}>Nom *</label><input style={S.input} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="Jean Dupont"/></div>
        <div style={S.field}><label style={S.lbl}>Téléphone *</label><input style={S.input} value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} placeholder="+33 6 12 34 56 78"/></div>
        <div style={S.field}><label style={S.lbl}>Email</label><input style={S.input} type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))} placeholder="jean@email.fr"/></div>
      </div>
      <div style={S.field}><label style={S.lbl}>Notes</label><textarea style={{...S.input,height:48,resize:'vertical'}} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))}/></div>
      <div style={{fontSize:11,color:'#6b7280',marginBottom:10}}>📱 SMS de confirmation envoyé automatiquement</div>

      <div style={{display:'flex',gap:7,justifyContent:'flex-end'}}>
        <button style={S.btn()} onClick={onClose}>Annuler</button>
        <button style={S.btn('primary')} onClick={handleSave}>
          ✓ Confirmer + SMS {buildItems().length>1?`(${buildItems().length} créneaux)`:''}
        </button>
      </div>
    </div>
  )
}

// ─── DETAIL MODAL ─────────────────────────────────────────────────────────────
function DetailModal({cfg,res,onToggleArrived,onToggleAcompte,onDelete,onUpdate,onResendSMS,onClose}) {
  const s=cfg.sessions.find(x=>x.id===res.session)
  const [editing,setEditing]=useState(false)
  const [editForm,setEditForm]=useState({
    participants:res.participants, date:res.date, time:res.time, notes:res.notes||''
  })

  async function handleUpdate() {
    await onUpdate(res.id,{participants:parseInt(editForm.participants),date:editForm.date,time:editForm.time,notes:editForm.notes})
    setEditing(false)
  }

  return (
    <div style={S.modal}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:3}}>
        <h3 style={{fontSize:15,fontWeight:700}}>{res.name}</h3>
        <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',fontSize:18,color:'#9ca3af'}}>✕</button>
      </div>
      <div style={{fontSize:12,color:'#9ca3af',marginBottom:12}}>
        {new Date(res.date+'T12:00:00').toLocaleDateString('fr-FR',{weekday:'long',day:'numeric',month:'long'})} à {res.time}
      </div>

      {/* Statuts cliquables avec couleurs */}
      <div style={{display:'flex',gap:8,marginBottom:14,flexWrap:'wrap'}}>
        <div onClick={()=>onToggleArrived(res.id)}
          style={{fontSize:12,padding:'7px 14px',borderRadius:20,background:res.arrived?'#059669':'#FEE2E2',color:res.arrived?'#fff':'#dc2626',cursor:'pointer',fontWeight:700,transition:'all 0.2s',border:`2px solid ${res.arrived?'#059669':'#fca5a5'}`,userSelect:'none'}}>
          {res.arrived?'✅ Arrivé':'⚠️ En attente — cliquer pour valider'}
        </div>
        <div onClick={()=>onToggleAcompte(res.id)}
          style={{fontSize:12,padding:'7px 14px',borderRadius:20,background:res.acompte_paid?'#059669':'#f3f4f6',color:res.acompte_paid?'#fff':'#6b7280',cursor:'pointer',fontWeight:700,transition:'all 0.2s',border:`2px solid ${res.acompte_paid?'#059669':'#e5e7eb'}`,userSelect:'none'}}>
          {res.acompte_paid?'💳 Acompte reçu':'💳 Acompte en attente — cliquer pour valider'}
        </div>
      </div>

      {editing ? (
        <div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:9}}>
            <div style={S.field}><label style={S.lbl}>Date</label><input style={S.input} type="date" value={editForm.date} onChange={e=>setEditForm(f=>({...f,date:e.target.value}))}/></div>
            <div style={S.field}><label style={S.lbl}>Heure</label><input style={S.input} type="time" value={editForm.time} onChange={e=>setEditForm(f=>({...f,time:e.target.value}))}/></div>
            <div style={S.field}><label style={S.lbl}>Participants</label><input style={S.input} type="number" min={1} value={editForm.participants} onChange={e=>setEditForm(f=>({...f,participants:e.target.value}))}/></div>
          </div>
          <div style={S.field}><label style={S.lbl}>Notes</label><textarea style={{...S.input,height:50,resize:'vertical'}} value={editForm.notes} onChange={e=>setEditForm(f=>({...f,notes:e.target.value}))}/></div>
          <div style={{display:'flex',gap:6,marginBottom:12}}>
            <button style={S.btn()} onClick={()=>setEditing(false)}>Annuler</button>
            <button style={S.btn('primary')} onClick={handleUpdate}>Enregistrer</button>
          </div>
        </div>
      ) : (
        <>
          {[
            ['Session', s?<span style={S.badge(s.bg,s.color)}>{s.label}</span>:'—'],
            ['Kart', res.kart_type],
            ['Participants', res.participants],
            ['Total', s?s.price*res.participants+'€':'—'],
            ['Acompte à régler', s?s.deposit+'€':'—'],
            ['Téléphone', res.phone],
            ['Email', res.email||'—'],
          ].map(([l,v])=>(
            <div key={l} style={{display:'flex',justifyContent:'space-between',padding:'5px 0',borderBottom:'1px solid #f3f4f6',fontSize:13}}>
              <span style={{color:'#9ca3af'}}>{l}</span><span>{v}</span>
            </div>
          ))}
          {res.notes&&<div style={{marginTop:8,padding:'7px 9px',background:'#f9fafb',borderRadius:7,fontSize:12,color:'#6b7280'}}>📝 {res.notes}</div>}
          <div style={{background:'#f9fafb',borderRadius:7,padding:'7px 10px',fontSize:11,margin:'10px 0'}}>
            <div style={{color:'#9ca3af',marginBottom:2}}>Lien acompte</div>
            <div style={{color:'#1D9E75',wordBreak:'break-all'}}>{res.deposit_link}</div>
          </div>
        </>
      )}

      <div style={{display:'flex',gap:6,justifyContent:'flex-end',flexWrap:'wrap',marginTop:4}}>
        <button style={S.btn('danger')} onClick={()=>onDelete(res.id)}>Supprimer</button>
        <button style={S.btn()} onClick={()=>setEditing(!editing)}>✏️ Modifier</button>
        <button style={S.btn('primary')} onClick={()=>{onResendSMS(res);onClose()}}>📱 Renvoyer SMS</button>
      </div>
    </div>
  )
}

// ─── EVENTS PAGE ──────────────────────────────────────────────────────────────
function EventsPage({cfg,reservations,saveReservation}) {
  const [eventType,setEventType]=useState('trophee')
  const [form,setForm]=useState({date:todayStr(),startTime:'14:00',name:'',phone:'',email:'',adulte:1,enfant:0,customSessions:[],notes:''})

  const EVENT_DEFS={
    trophee:{label:'🏆 Trophée',desc:'Chrono + Course (2 créneaux)',sessions:[{label:'Chrono'},{label:'Course'}]},
    challenge:{label:'⚡ Challenge',desc:'Essai + Chrono + Course (3 créneaux)',sessions:[{label:'Essai'},{label:'Chrono'},{label:'Course'}]},
    custom:{label:'✏️ Sur mesure',desc:'Vos propres sessions',sessions:form.customSessions},
  }
  const sessions=eventType==='custom'?form.customSessions:EVENT_DEFS[eventType].sessions

  function computeEventSlots() {
    const h=getHoraires(form.date,cfg); if(!h) return []
    const all=getAllSlots(h[0],h[1])
    let idx=all.indexOf(form.startTime); if(idx<0) return []
    const result=[]
    for (const s of sessions) {
      while(idx<all.length&&isPause(all[idx]))idx++
      if(idx>=all.length)break
      result.push({...s,time:all[idx]})
      idx++
      while(idx<all.length&&isPause(all[idx]))idx++
    }
    return result
  }

  const eventSlots=computeEventSlots()
  const existingRes=reservations.filter(r=>r.date===form.date)

  async function handleCreate() {
    if(!form.name.trim()||!form.phone.trim()){alert('Nom et téléphone obligatoires.');return}
    if(sessions.length===0){alert('Ajoutez au moins une session.');return}
    if(!parseInt(form.adulte)&&!parseInt(form.enfant)){alert('Ajoutez des participants.');return}
    const items=[]
    for (const slot of eventSlots) {
      if(parseInt(form.adulte)>0) items.push({dateStr:form.date,time:slot.time,name:form.name,phone:form.phone,email:form.email,session:cfg.sessions[0]?.id,participants:parseInt(form.adulte),kart_type:'adulte',notes:`${EVENT_DEFS[eventType].label} · ${slot.label}${form.notes?' · '+form.notes:''}`})
      if(parseInt(form.enfant)>0&&slot.time<`${String(ENFANT_MAX_HOUR).padStart(2,'0')}:00`) items.push({dateStr:form.date,time:slot.time,name:form.name,phone:form.phone,email:form.email,session:cfg.sessions[1]?.id||cfg.sessions[0]?.id,participants:parseInt(form.enfant),kart_type:'enfant',notes:`${EVENT_DEFS[eventType].label} · ${slot.label}${form.notes?' · '+form.notes:''}`})
    }
    const ok=await saveReservation(items)
    if(ok) setForm(f=>({...f,name:'',phone:'',email:'',notes:'',adulte:1,enfant:0}))
  }

  return (
    <div style={{paddingTop:14,maxWidth:580}}>
      <div style={{fontSize:15,fontWeight:700,marginBottom:3}}>Créer un événement</div>
      <div style={{fontSize:12,color:'#9ca3af',marginBottom:14}}>Créneaux toutes les 15min · Pauses auto · Inscrit dans le planning + SMS</div>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:7,marginBottom:14}}>
        {Object.entries(EVENT_DEFS).map(([k,et])=>(
          <div key={k} onClick={()=>setEventType(k)} style={{border:`${eventType===k?'2px':'1px'} solid ${eventType===k?'#1D9E75':'#e5e7eb'}`,borderRadius:9,padding:'10px 12px',cursor:'pointer',background:eventType===k?'#E1F5EE':'#fff'}}>
            <div style={{fontSize:13,fontWeight:700,color:eventType===k?'#1D9E75':'#111'}}>{et.label}</div>
            <div style={{fontSize:10,color:'#9ca3af',marginTop:3,lineHeight:1.4}}>{et.desc}</div>
          </div>
        ))}
      </div>
      {eventType==='custom'&&(
        <div style={{marginBottom:12}}>
          {form.customSessions.map((cs,i)=>(
            <div key={i} style={{display:'flex',gap:6,alignItems:'center',marginBottom:6}}>
              <input style={{...S.input,flex:1}} placeholder="Nom de la session" value={cs.label} onChange={e=>setForm(f=>{const cs=[...f.customSessions];cs[i]={...cs[i],label:e.target.value};return{...f,customSessions:cs}})}/>
              <button style={S.btn('danger')} onClick={()=>setForm(f=>({...f,customSessions:f.customSessions.filter((_,idx)=>idx!==i)}))}>✕</button>
            </div>
          ))}
          <button style={S.btn()} onClick={()=>setForm(f=>({...f,customSessions:[...f.customSessions,{label:'Session'}]}))}>+ Session</button>
        </div>
      )}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:9,marginBottom:9}}>
        <div style={S.field}><label style={S.lbl}>Date</label><input style={S.input} type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))}/></div>
        <div style={S.field}><label style={S.lbl}>Heure de début</label><input style={S.input} type="time" value={form.startTime} onChange={e=>setForm(f=>({...f,startTime:e.target.value}))}/></div>
      </div>
      {eventSlots.length>0&&(
        <div style={{background:'#f9fafb',borderRadius:9,padding:'10px 12px',marginBottom:12,border:'1px solid #e5e7eb'}}>
          <div style={{fontSize:10,fontWeight:700,color:'#9ca3af',marginBottom:8,textTransform:'uppercase'}}>📅 Créneaux dans le planning</div>
          {eventSlots.map((s,i)=>{
            const existing=existingRes.filter(r=>r.time===s.time)
            return (
              <div key={i} style={{display:'flex',alignItems:'center',gap:8,fontSize:12,marginBottom:4,padding:'5px 8px',borderRadius:7,background:'#fff',border:'1px solid #e5e7eb'}}>
                <span style={{fontWeight:700,color:'#1D9E75',minWidth:42}}>{s.time}</span>
                <span style={{fontWeight:600}}>{s.label}</span>
                {existing.map(r=><span key={r.id} style={S.badge('#f3f4f6','#6b7280')}>{r.name}</span>)}
                {existing.length>0&&<span style={{fontSize:10,color:'#EA580C'}}>⚠️ occupé</span>}
              </div>
            )
          })}
        </div>
      )}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:9,marginBottom:9}}>
        <div style={S.field}><label style={S.lbl}>Nom *</label><input style={S.input} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="Jean Dupont"/></div>
        <div style={S.field}><label style={S.lbl}>🟢 Adultes</label><input style={S.input} type="number" min={0} value={form.adulte} onChange={e=>setForm(f=>({...f,adulte:e.target.value}))}/></div>
        <div style={S.field}><label style={S.lbl}>🟡 Enfants</label><input style={S.input} type="number" min={0} value={form.enfant} onChange={e=>setForm(f=>({...f,enfant:e.target.value}))}/></div>
        <div style={S.field}><label style={S.lbl}>Téléphone *</label><input style={S.input} value={form.phone} onChange={e=>setForm(f=>({...f,phone:e.target.value}))} placeholder="+33 6..."/></div>
        <div style={S.field}><label style={S.lbl}>Email</label><input style={S.input} type="email" value={form.email} onChange={e=>setForm(f=>({...f,email:e.target.value}))}/></div>
      </div>
      <div style={S.field}><label style={S.lbl}>Notes</label><textarea style={{...S.input,height:44,resize:'vertical'}} value={form.notes} onChange={e=>setForm(f=>({...f,notes:e.target.value}))}/></div>
      <button style={{...S.btn('primary'),padding:'10px 24px',fontSize:13,width:'100%'}} onClick={handleCreate}>
        🏁 Créer + inscrire dans le planning ({eventSlots.length} créneaux)
      </button>
    </div>
  )
}

// ─── CONFIG MODAL ─────────────────────────────────────────────────────────────
function ConfigModal({cfg,onSave,onClose,showToast}) {
  const [form,setForm]=useState(JSON.parse(JSON.stringify(cfg)))
  const [section,setSection]=useState('general')
  function save(){onSave(form);onClose();showToast('✓ Configuration enregistrée')}
  function updSess(id,field,val){setForm(f=>({...f,sessions:f.sessions.map(s=>s.id===id?{...s,[field]:val}:s)}))}
  function addSess(){
    const colors=['#1D9E75','#BA7517','#E24B4A','#7F77DD','#378ADD']
    const bgs=['#E1F5EE','#FAEEDA','#FCEBEB','#EEEDFE','#E6F1FB']
    const i=form.sessions.length%5
    setForm(f=>({...f,sessions:[...f.sessions,{id:'s'+Date.now(),label:'Nouvelle',price:20,deposit:5,color:colors[i],bg:bgs[i]}]}))
  }
  function rmSess(id){if(form.sessions.length<=1){alert('Min 1.');return}setForm(f=>({...f,sessions:f.sessions.filter(s=>s.id!==id)}))}

  return (
    <div style={{...S.modal,width:'min(540px,96vw)'}}>
      <div style={{display:'flex',justifyContent:'space-between',marginBottom:14}}>
        <h3 style={{fontSize:15,fontWeight:700}}>Configuration</h3>
        <button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',fontSize:18,color:'#9ca3af'}}>✕</button>
      </div>
      <div style={{display:'flex',gap:2,background:'#f0f1f3',borderRadius:8,padding:3,marginBottom:16}}>
        {[['general','Général'],['horaires','Horaires'],['sessions','Sessions'],['sms','SMS']].map(([k,l])=>(
          <button key={k} style={S.tab(section===k)} onClick={()=>setSection(k)}>{l}</button>
        ))}
      </div>

      {section==='general'&&(
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:9}}>
          <div style={S.field}><label style={S.lbl}>Nom</label><input style={S.input} value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))}/></div>
          <div style={S.field}><label style={S.lbl}>Ville</label><input style={S.input} value={form.city} onChange={e=>setForm(f=>({...f,city:e.target.value}))}/></div>
          <div style={S.field}><label style={S.lbl}>Karts adulte</label><input style={S.input} type="number" min={1} value={form.kart_adulte} onChange={e=>setForm(f=>({...f,kart_adulte:+e.target.value}))}/></div>
          <div style={S.field}><label style={S.lbl}>Karts enfant</label><input style={S.input} type="number" min={1} value={form.kart_enfant} onChange={e=>setForm(f=>({...f,kart_enfant:+e.target.value}))}/></div>
        </div>
      )}

      {section==='horaires'&&(
        <div>
          <div style={{fontSize:11,color:'#6b7280',marginBottom:12,lineHeight:1.8,background:'#f9fafb',padding:'8px 10px',borderRadius:7}}>
            📅 <b>Mer</b> 14h-22h · <b>Jeu</b> 16h-22h · <b>Ven</b> 16h-22h · <b>Sam</b> 14h-22h · <b>Dim</b> 14h-20h<br/>
            🏖️ <b>Vacances</b> : tous les jours 14h-22h<br/>
            🔑 <b>Lun/Mar</b> : fermés sauf exceptions<br/>
            ⏸ <b>Pauses auto</b> : heures piles · ⛽ 19h · 🍽️ 20h
          </div>
          <div style={{fontSize:12,fontWeight:600,marginBottom:7}}>🏖️ Vacances scolaires</div>
          {(form.vacances||[]).map((v,i)=>(
            <div key={i} style={{display:'flex',gap:6,alignItems:'center',marginBottom:7,flexWrap:'wrap'}}>
              <input style={{...S.input,width:110}} placeholder="Label" value={v.label} onChange={e=>setForm(f=>{const vv=[...(f.vacances||[])];vv[i]={...vv[i],label:e.target.value};return{...f,vacances:vv}})}/>
              <input style={{...S.input,width:130}} type="date" value={v.start} onChange={e=>setForm(f=>{const vv=[...(f.vacances||[])];vv[i]={...vv[i],start:e.target.value};return{...f,vacances:vv}})}/>
              <span style={{color:'#9ca3af'}}>→</span>
              <input style={{...S.input,width:130}} type="date" value={v.end} onChange={e=>setForm(f=>{const vv=[...(f.vacances||[])];vv[i]={...vv[i],end:e.target.value};return{...f,vacances:vv}})}/>
              <button style={S.btn('danger')} onClick={()=>setForm(f=>({...f,vacances:(f.vacances||[]).filter((_,idx)=>idx!==i)}))}>✕</button>
            </div>
          ))}
          <button style={S.btn()} onClick={()=>setForm(f=>({...f,vacances:[...(f.vacances||[]),{start:todayStr(),end:todayStr(),label:'Vacances'}]}))}>+ Période</button>
          <div style={{fontSize:12,fontWeight:600,marginTop:16,marginBottom:7}}>🔑 Lun/Mar exceptionnels</div>
          {(form.jours_exceptionnels||[]).map((j,i)=>(
            <div key={i} style={{display:'flex',gap:7,alignItems:'center',marginBottom:7,flexWrap:'wrap'}}>
              <input style={{...S.input,width:140}} type="date" value={j.date} onChange={e=>setForm(f=>{const je=[...(f.jours_exceptionnels||[])];je[i]={...je[i],date:e.target.value};return{...f,jours_exceptionnels:je}})}/>
              <span style={{fontSize:11}}>14h →</span>
              <input style={{...S.input,width:55}} type="number" min={15} max={23} value={j.close||20} onChange={e=>setForm(f=>{const je=[...(f.jours_exceptionnels||[])];je[i]={...je[i],open:14,close:+e.target.value};return{...f,jours_exceptionnels:je}})}/>
              <span style={{fontSize:11}}>h</span>
              <button style={S.btn('danger')} onClick={()=>setForm(f=>({...f,jours_exceptionnels:(f.jours_exceptionnels||[]).filter((_,idx)=>idx!==i)}))}>✕</button>
            </div>
          ))}
          <button style={S.btn()} onClick={()=>setForm(f=>({...f,jours_exceptionnels:[...(f.jours_exceptionnels||[]),{date:todayStr(),open:14,close:20}]}))}>+ Jour</button>
        </div>
      )}

      {section==='sessions'&&(
        <div>
          <div style={{fontSize:11,color:'#9ca3af',marginBottom:10}}>2 sessions recommandées : ADULTES et ENFANTS</div>
          <div style={{display:'grid',gridTemplateColumns:'18px 1fr 60px 65px 50px 50px 18px',gap:5,marginBottom:6,fontSize:10,color:'#9ca3af'}}>
            <div/><div>Nom</div><div>Prix €</div><div>Acompte €</div><div>Couleur</div><div>Fond</div><div/>
          </div>
          {form.sessions.map(s=>(
            <div key={s.id} style={{display:'grid',gridTemplateColumns:'18px 1fr 60px 65px 50px 50px 18px',gap:5,marginBottom:6,alignItems:'center'}}>
              <input type="color" value={s.color} onChange={e=>updSess(s.id,'color',e.target.value)} style={{width:18,height:18,border:'none',cursor:'pointer',padding:0,borderRadius:3}}/>
              <input style={{...S.input,fontSize:12,padding:'4px 7px'}} value={s.label} onChange={e=>updSess(s.id,'label',e.target.value)}/>
              <input style={{...S.input,fontSize:12,padding:'4px 7px'}} type="number" value={s.price} onChange={e=>updSess(s.id,'price',+e.target.value)}/>
              <input style={{...S.input,fontSize:12,padding:'4px 7px'}} type="number" value={s.deposit} onChange={e=>updSess(s.id,'deposit',+e.target.value)}/>
              <input type="color" value={s.bg} onChange={e=>updSess(s.id,'bg',e.target.value)} style={{width:46,height:18,border:'none',cursor:'pointer',padding:0,borderRadius:3}}/>
              <div/>
              <button onClick={()=>rmSess(s.id)} style={{background:'none',border:'none',cursor:'pointer',color:'#9ca3af',fontSize:14}}>✕</button>
            </div>
          ))}
          <button onClick={addSess} style={{background:'none',border:'1px dashed #e5e7eb',borderRadius:7,padding:'7px',width:'100%',fontSize:12,color:'#9ca3af',cursor:'pointer',marginTop:4}}>+ Ajouter</button>
        </div>
      )}

      {section==='sms'&&(
        <div>
          <div style={{background:'#E1F5EE',border:'1px solid #1D9E75',borderRadius:8,padding:'10px 12px',marginBottom:12,fontSize:12,color:'#0F6E56',lineHeight:1.6}}>
            ✅ <b>SMS Brevo activé</b> via fonction Vercel.<br/>
            Les SMS sont envoyés automatiquement via <code>/api/send-sms</code>.<br/>
            La clé API Brevo est dans les variables d'environnement Vercel.
          </div>
          <div style={S.field}>
            <label style={S.lbl}>Template SMS</label>
            <div style={{fontSize:11,color:'#9ca3af',marginBottom:5}}>Variables : {'{nom} {karting} {date} {heure} {session} {participants} {acompte} {lien}'}</div>
            <textarea style={{...S.input,height:90,resize:'vertical'}} value={form.sms} onChange={e=>setForm(f=>({...f,sms:e.target.value}))}/>
          </div>
        </div>
      )}

      <div style={{display:'flex',gap:6,justifyContent:'flex-end',marginTop:16,paddingTop:12,borderTop:'1px solid #f3f4f6'}}>
        <button style={S.btn()} onClick={()=>{if(window.confirm('Réinitialiser ?'))setForm(JSON.parse(JSON.stringify(DEFAULT_CFG)))}}>Réinitialiser</button>
        <button style={S.btn('primary')} onClick={save}>Enregistrer</button>
      </div>
    </div>
  )
}
