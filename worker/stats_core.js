// STATS_CORE_BEGIN
function fbStatsCompute(raw, today, nMonths){
  const tasks = raw.tasks || {}, claims = raw.claims || {}, log = raw.log || {}, notes = raw.notes || {}, members = raw.members || {};
  const mk = iso => { const t = Date.parse(iso); return isNaN(t) ? "" : new Date(t + 3 * 3600 * 1000).toISOString().slice(0, 7); };
  const curKey = String(today).slice(0, 7);
  const keys = [];
  { let y = +curKey.slice(0, 4), m = +curKey.slice(5, 7);
    for(let i = 0; i < (nMonths || 6); i++){ keys.unshift(y + "-" + String(m).padStart(2, "0")); m--; if(m === 0){ m = 12; y--; } } }
  const M = {};
  keys.forEach(k => { M[k] = { key: k, registered: 0, added: 0, bookings: 0, cancels: 0, proofs: 0, due: 0, dueDone: 0, active: {}, hours: 0, hoursN: 0,
    lead: {}, noteBy: {}, doneTasks: [] }; });
  Object.keys(log).forEach(id => {
    const e = log[id] || {}, k = mk(e.createdAt), m = M[k]; if(!m) return;
    const t = String(e.type || "");
    if(t === "إضافة مهمة") m.added++;
    else if(t === "حجز" || t === "انضمام لفريق") m.bookings++;
    else if(t === "إلغاء حجز") m.cancels++;
    else if(t === "إثبات إنجاز") m.proofs++;
  });
  const isGroup = t => t && (t.type === "group" || t.type === "assigned");
  const doneTask = (t, c) => {
    c = c || {};
    if(!isGroup(t)){ return !!((c.primary && c.primary.proofUrl) || (c.backup && c.backup.proofUrl)); }
    const ks = Object.keys(c); return ks.length > 0 && ks.every(r => c[r] && c[r].proofUrl);
  };
  const snap = { open: 0, overdue: 0, unbooked: 0, doneTotal: 0, tasksTotal: 0, members: 0, banned: 0 }, overdueList = [], unbookedList = [];
  const notesOf = id => { const o = notes[id] || {}; return Object.keys(o).map(n => ({ by: o[n].byName || "—", text: o[n].text || "", at: o[n].createdAt || "" }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at))); };
  Object.keys(tasks).forEach(id => {
    const t = tasks[id] || {}, c = claims[id] || {}, d = doneTask(t, c);
    snap.tasksTotal++; if(d) snap.doneTotal++;
    if(!t.archived && !d){
      if(t.dueDate && t.dueDate < today){ snap.overdue++; overdueList.push({ title: t.title || "", dueDate: t.dueDate }); }
      else { snap.open++; if(!Object.keys(c).length){ snap.unbooked++; unbookedList.push({ title: t.title || "", dueDate: t.dueDate || "" }); } }
    }
    const ck = mk(t.createdAt), cm = M[ck];
    if(cm){ const nm = t.createdBy || "غير مسجّل"; cm.lead[nm] = (cm.lead[nm] || 0) + 1; }
    const k = String(t.dueDate || "").slice(0, 7), m = M[k];
    if(m){ m.due++; if(d) m.dueDone++; }
    let lastProof = "", names = {};
    Object.keys(c).forEach(r => {
      const cl = c[r] || {}, ak = mk(cl.claimedAt), pk = mk(cl.proofSubmittedAt), who = cl.uid || cl.name || "";
      if(M[ak] && who) M[ak].active[who] = 1;
      if(cl.proofSubmittedAt){ names[cl.name || "—"] = 1; if(String(cl.proofSubmittedAt) > lastProof) lastProof = cl.proofSubmittedAt; }
      if(M[pk]){ if(who) M[pk].active[who] = 1;
        const a = Date.parse(cl.claimedAt), b = Date.parse(cl.proofSubmittedAt); if(!isNaN(a) && !isNaN(b) && b >= a){ M[pk].hours += (b - a) / 3600000; M[pk].hoursN++; } }
    });
    const dk = mk(lastProof);
    if(d && M[dk]) M[dk].doneTasks.push({ id, title: t.title || "", by: Object.keys(names), at: lastProof, createdBy: t.createdBy || "", notes: notesOf(id) });
  });
  Object.keys(members).forEach(u => { const x = members[u] || {}; snap.members++; if(x.bannedAt) snap.banned++; const m = M[mk(x.registeredAt)]; if(m) m.registered++; });
  Object.keys(notes).forEach(tid => Object.keys(notes[tid] || {}).forEach(n => {
    const e = notes[tid][n] || {}, m = M[mk(e.createdAt)]; if(m){ const nm = e.byName || "—"; m.noteBy[nm] = (m.noteBy[nm] || 0) + 1; } }));
  const months = keys.map(k => { const m = M[k];
    const names = {}; Object.keys(m.lead).forEach(n => names[n] = 1); Object.keys(m.noteBy).forEach(n => names[n] = 1);
    return { key: k, registered: m.registered, added: m.added, bookings: m.bookings, cancels: m.cancels, proofs: m.proofs,
      due: m.due, dueDone: m.dueDone, rate: m.due ? Math.round(m.dueDone * 100 / m.due) : null,
      cancelRate: m.bookings ? Math.round(m.cancels * 100 / m.bookings) : null, active: Object.keys(m.active).length,
      avgHours: m.hoursN ? Math.round(m.hours / m.hoursN * 10) / 10 : null,
      leaders: Object.keys(names).map(n => ({ name: n, added: m.lead[n] || 0, notes: m.noteBy[n] || 0 })).sort((a, b) => (b.added + b.notes) - (a.added + a.notes)),
      doneTasks: m.doneTasks.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 40) }; });
  overdueList.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  unbookedList.sort((a, b) => String(a.dueDate || "9").localeCompare(String(b.dueDate || "9")));
  return { today, current: curKey, months, snapshot: Object.assign(snap, { overdueList: overdueList.slice(0, 8), unbookedList: unbookedList.slice(0, 8) }) };
}

module.exports = { fbStatsCompute };
