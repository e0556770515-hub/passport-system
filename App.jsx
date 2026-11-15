import { useEffect, useMemo, useState, useCallback } from 'react'
import { supabase } from './supabase'

const BUCKET = 'passports'
const ALLOWED = ['image/jpeg', 'image/png', 'application/pdf']
const fmt = d => new Date(d).toLocaleString('he-IL')
const norm = s => (s || '').toLowerCase().replace(/\s+/g, ' ').trim()
const sha256 = async f => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await f.arrayBuffer()))]
  .map(b => b.toString(16).padStart(2, '0')).join('')
const ACTIONS = { upload: 'העלאה', edit: 'עריכה', delete: 'מחיקה', view: 'צפייה', download: 'הורדה' }

export default function App() {
  const [session, setSession] = useState(undefined)
  const [profile, setProfile] = useState(null)
  const [blocked, setBlocked] = useState('')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) { setProfile(null); return }
    supabase.from('profiles').select('*').eq('id', session.user.id).single().then(async ({ data }) => {
      if (!data || !data.active) { setBlocked('החשבון שלך אינו פעיל. פנה למנהל המערכת.'); await supabase.auth.signOut() }
      else { setBlocked(''); setProfile(data) }
    })
  }, [session])

  if (session === undefined) return null
  if (!session || !profile) return <Login blocked={blocked} />
  return <Main profile={profile} />
}

function Login({ blocked }) {
  const [email, setEmail] = useState(''), [pw, setPw] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false)
  const go = async e => {
    e.preventDefault(); setBusy(true); setErr('')
    const { error } = await supabase.auth.signInWithPassword({ email, password: pw })
    if (error) setErr('אימייל או סיסמה שגויים'); setBusy(false)
  }
  return (
    <form className="login" onSubmit={go}>
      <h1>ארכיון דרכונים</h1><p>התחברות למשתמשים מורשים בלבד</p>
      <label>אימייל</label><input type="email" value={email} onChange={e => setEmail(e.target.value)} required dir="ltr" />
      <label>סיסמה</label><input type="password" value={pw} onChange={e => setPw(e.target.value)} required dir="ltr" />
      {(err || blocked) && <p className="err">{err || blocked}</p>}
      <div className="acts"><button className="pri" disabled={busy} style={{ width: '100%' }}>התחברות</button></div>
    </form>
  )
}

function Main({ profile }) {
  const isAdmin = profile.role === 'admin'
  const [tab, setTab] = useState('home')
  const [rows, setRows] = useState([]), [q, setQ] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('')
  const [upOpen, setUpOpen] = useState(false), [sel, setSel] = useState(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('passports').select('*').order('uploaded_at', { ascending: false })
    setRows(data || [])
  }, [])
  useEffect(() => {
    load()
    const ch = supabase.channel('pp').on('postgres_changes', { event: '*', schema: 'public', table: 'passports' }, load).subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [load])

  const res = useMemo(() => {
    const terms = norm(q).split(' ').filter(Boolean)
    return rows.filter(r => {
      const hay = norm(`${r.first_name} ${r.last_name} ${r.last_name} ${r.first_name} ${r.passport_number || ''}`)
      if (!terms.every(t => hay.includes(t))) return false
      const d = r.uploaded_at.slice(0, 10)
      return (!from || d >= from) && (!to || d <= to)
    })
  }, [rows, q, from, to])

  return (
    <>
      <header>
        <h1>🛂 ארכיון דרכונים</h1>
        <button className={tab === 'home' ? 'on' : ''} onClick={() => setTab('home')}>דרכונים</button>
        {isAdmin && <button className={tab === 'admin' ? 'on' : ''} onClick={() => setTab('admin')}>ניהול</button>}
        <span style={{ opacity: .7, fontSize: '.85rem' }}>{profile.email}</span>
        <button onClick={() => supabase.auth.signOut()}>יציאה</button>
      </header>
      <main>
        {tab === 'home' ? <>
          <div className="hero">
            <button className="pri big" onClick={() => setUpOpen(true)}>＋ העלאת דרכון</button>
            <div className="stat"><b>{rows.length}</b>דרכונים שמורים</div>
          </div>
          <input className="search" placeholder="חיפוש לפי שם פרטי, שם משפחה או שם מלא…" value={q} onChange={e => setQ(e.target.value)} autoFocus />
          <div className="filters">הועלה בין
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} /> לבין
            <input type="date" value={to} onChange={e => setTo(e.target.value)} />
            {(from || to) && <button onClick={() => { setFrom(''); setTo('') }}>נקה</button>}
            <span>{res.length} תוצאות</span>
          </div>
          <div className="list">
            {res.length === 0 ? <div className="empty">{rows.length ? 'לא נמצאו תוצאות' : 'עדיין לא הועלו דרכונים'}</div> :
              res.map(r => (
                <div className="row" key={r.id} onClick={() => setSel(r)}>
                  <div className="n">{r.first_name} {r.last_name}</div>
                  <div className="m">{r.passport_number ? `מס׳ ${r.passport_number} · ` : ''}{fmt(r.uploaded_at)}</div>
                </div>))}
          </div>
        </> : <Admin />}
      </main>
      {upOpen && <Upload uid={profile.id} onClose={() => { setUpOpen(false); load() }} />}
      {sel && <Detail p={sel} profile={profile} onClose={() => { setSel(null); load() }} />}
    </>
  )
}

function Upload({ uid, onClose }) {
  const [items, setItems] = useState([]), [busy, setBusy] = useState(false)
  const pick = e => {
    const fs = [...e.target.files]
    setItems(it => [...it, ...fs.map(file => ({ file, first: '', last: '', num: '', notes: '', st: ALLOWED.includes(file.type) ? '' : 'סוג קובץ לא נתמך (JPG, PNG, PDF בלבד)', bad: !ALLOWED.includes(file.type) }))])
  }
  const set = (i, k, v) => setItems(it => it.map((x, j) => j === i ? { ...x, [k]: v } : x))
  const save = async () => {
    setBusy(true)
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (it.done || it.bad) continue
      if (!it.first.trim() || !it.last.trim()) { set(i, 'st', 'חובה למלא שם פרטי ושם משפחה'); continue }
      set(i, 'st', 'מעלה…')
      try {
        const hash = await sha256(it.file)
        const dup = await supabase.from('passports').select('first_name,last_name').eq('file_hash', hash).maybeSingle()
        if (dup.data) { set(i, 'st', `כפילות: הקובץ כבר קיים (${dup.data.first_name} ${dup.data.last_name})`); continue }
        const ext = it.file.name.split('.').pop().toLowerCase()
        const path = `${uid}/${crypto.randomUUID()}.${ext}`
        const up = await supabase.storage.from(BUCKET).upload(path, it.file, { contentType: it.file.type, upsert: false })
        if (up.error) throw up.error
        const ins = await supabase.from('passports').insert({
          first_name: it.first.trim(), last_name: it.last.trim(), passport_number: it.num.trim() || null, notes: it.notes.trim() || null,
          file_path: path, file_name: it.file.name, file_type: it.file.type, file_hash: hash, uploaded_by: uid })
        if (ins.error) { await supabase.storage.from(BUCKET).remove([path]); throw ins.error }
        setItems(x => x.map((y, j) => j === i ? { ...y, done: true, st: '✓ נשמר' } : y))
      } catch (e) {
        set(i, 'st', /passports_number_uq/.test(e.message) ? 'כפילות: מספר הדרכון כבר קיים במערכת' : 'שגיאה: ' + e.message)
      }
    }
    setBusy(false)
  }
  const allDone = items.length > 0 && items.every(i => i.done)
  return (
    <div className="back"><div className="modal">
      <h2>העלאת דרכונים</h2>
      <input type="file" accept="image/jpeg,image/png,application/pdf" multiple onChange={pick} />
      {items.map((it, i) => (
        <div className="up" key={i}>
          <div className="fn">{it.file.name}</div>
          {!it.bad && !it.done && <>
            <div className="g2">
              <div><label>שם פרטי *</label><input value={it.first} onChange={e => set(i, 'first', e.target.value)} /></div>
              <div><label>שם משפחה *</label><input value={it.last} onChange={e => set(i, 'last', e.target.value)} /></div>
            </div>
            <label>מספר דרכון (אופציונלי)</label><input dir="ltr" value={it.num} onChange={e => set(i, 'num', e.target.value)} />
            <label>הערות (אופציונלי)</label><textarea rows="2" value={it.notes} onChange={e => set(i, 'notes', e.target.value)} />
          </>}
          {it.st && <div className={it.done ? 'ok' : it.st === 'מעלה…' ? '' : 'err'}>{it.st}</div>}
        </div>))}
      <div className="acts">
        {!allDone && <button className="pri" disabled={busy || !items.length} onClick={save}>{busy ? 'שומר…' : 'שמירה'}</button>}
        <button onClick={onClose}>{allDone ? 'סגירה' : 'ביטול'}</button>
      </div>
    </div></div>
  )
}

function Detail({ p, profile, onClose }) {
  const [url, setUrl] = useState(''), [zoom, setZoom] = useState(false), [edit, setEdit] = useState(false)
  const [f, setF] = useState({ first_name: p.first_name, last_name: p.last_name, passport_number: p.passport_number || '', notes: p.notes || '' })
  const [msg, setMsg] = useState('')
  const isAdmin = profile.role === 'admin', canDl = isAdmin || profile.can_download
  useEffect(() => {
    supabase.storage.from(BUCKET).createSignedUrl(p.file_path, 120).then(({ data }) => setUrl(data?.signedUrl || ''))
    supabase.rpc('log_action', { p_action: 'view', p_passport: p.id })
  }, [p])
  const save = async () => {
    const { error } = await supabase.from('passports').update({ ...f, passport_number: f.passport_number.trim() || null, notes: f.notes.trim() || null }).eq('id', p.id)
    if (error) setMsg(/passports_number_uq/.test(error.message) ? 'מספר הדרכון כבר קיים במערכת' : error.message); else onClose()
  }
  const download = async () => {
    const { data } = await supabase.storage.from(BUCKET).createSignedUrl(p.file_path, 60, { download: p.file_name || true })
    if (data) { supabase.rpc('log_action', { p_action: 'download', p_passport: p.id }); window.location.href = data.signedUrl }
  }
  const del = async () => {
    if (!confirm('למחוק את הדרכון לצמיתות?')) return
    await supabase.storage.from(BUCKET).remove([p.file_path])
    const { error } = await supabase.from('passports').delete().eq('id', p.id)
    if (error) setMsg(error.message); else onClose()
  }
  return (
    <div className="back"><div className="modal">
      <h2>{p.first_name} {p.last_name}</h2>
      {edit ? <>
        <div className="g2">
          <div><label>שם פרטי</label><input value={f.first_name} onChange={e => setF({ ...f, first_name: e.target.value })} /></div>
          <div><label>שם משפחה</label><input value={f.last_name} onChange={e => setF({ ...f, last_name: e.target.value })} /></div>
        </div>
        <label>מספר דרכון</label><input dir="ltr" value={f.passport_number} onChange={e => setF({ ...f, passport_number: e.target.value })} />
        <label>הערות</label><textarea rows="2" value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} />
      </> : <p style={{ color: 'var(--mut)' }}>
        {p.passport_number && <>מספר דרכון: <b dir="ltr">{p.passport_number}</b><br /></>}
        {p.notes && <>הערות: {p.notes}<br /></>}הועלה: {fmt(p.uploaded_at)}</p>}
      <div className="view">
        {!url ? <p>טוען…</p> : p.file_type === 'application/pdf' ? <iframe src={url} title="pdf" /> :
          <img src={url} alt="דרכון" className={zoom ? 'z' : ''} onClick={() => setZoom(!zoom)} />}
      </div>
      {msg && <p className="err">{msg}</p>}
      <div className="acts">
        {edit ? <button className="pri" onClick={save}>שמירת שינויים</button> : <button onClick={() => setEdit(true)}>עריכה</button>}
        {canDl && <button onClick={download}>הורדה</button>}
        {isAdmin && <button className="dan" onClick={del}>מחיקה</button>}
        <button onClick={onClose}>סגירה</button>
      </div>
    </div></div>
  )
}

function Admin() {
  const [users, setUsers] = useState([]), [log, setLog] = useState([])
  const load = async () => {
    setUsers((await supabase.from('profiles').select('*').order('created_at')).data || [])
    setLog((await supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(200)).data || [])
  }
  useEffect(() => { load() }, [])
  const upd = async (id, patch) => { await supabase.from('profiles').update(patch).eq('id', id); load() }
  return <>
    <h2>משתמשים</h2>
    <p style={{ color: 'var(--mut)' }}>להוספת משתמש חדש: Supabase ← Authentication ← Users ← Add user. הוא יופיע כאן אוטומטית.</p>
    <div style={{ overflow: 'auto' }}><table>
      <thead><tr><th>אימייל</th><th>תפקיד</th><th>הורדה</th><th>סטטוס</th></tr></thead>
      <tbody>{users.map(u => <tr key={u.id}>
        <td dir="ltr" style={{ textAlign: 'right' }}>{u.email}</td>
        <td><button onClick={() => upd(u.id, { role: u.role === 'admin' ? 'user' : 'admin' })}>{u.role === 'admin' ? 'מנהל ↓' : 'משתמש ↑'}</button></td>
        <td><input type="checkbox" style={{ width: 'auto' }} checked={u.can_download} onChange={e => upd(u.id, { can_download: e.target.checked })} /></td>
        <td><button className={u.active ? 'dan' : ''} onClick={() => upd(u.id, { active: !u.active })}>{u.active ? 'חסימה' : 'הפעלה'}</button></td>
      </tr>)}</tbody></table></div>
    <h2>היסטוריית פעולות</h2>
    <div style={{ overflow: 'auto' }}><table>
      <thead><tr><th>זמן</th><th>משתמש</th><th>פעולה</th><th>דרכון</th></tr></thead>
      <tbody>{log.map(l => <tr key={l.id}><td>{fmt(l.created_at)}</td><td dir="ltr" style={{ textAlign: 'right' }}>{l.user_email}</td>
        <td>{ACTIONS[l.action] || l.action}</td><td>{l.details?.name || ''}</td></tr>)}</tbody></table></div>
  </>
}
