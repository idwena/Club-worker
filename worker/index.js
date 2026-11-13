// عامل نادي الإرشاد السياحي — يشتغل مجانًا على GitHub Actions
//   node index.js events   → يرسل إيميلات الأحداث (حجز، إلغاء، مهمة جديدة، تعيين، رسالة، استبعاد، ترحيب…)
//   node index.js daily    → التذكيرات اليومية + الإنذار/الاستبعاد التلقائي + أرشفة بطل الشهر
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});
const db = admin.database();
const FROM = `"اللجنة التنفيذية - نادي الإرشاد السياحي" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SMTP_USER;
const MAX_MAILS_PER_RUN = Number(process.env.MAX_MAILS_PER_RUN || 150); // حماية من تجاوز حد المرسل اليومي
const port = Number(process.env.SMTP_PORT || 465);
const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST, port, secure: port === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

let sent = 0;
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const wrap = html => `<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;">${html}</div>`;
const ek = e => String(e || "").trim().toLowerCase().replace(/\s+/g, "").replace(/[.#$\[\]\/]/g, ",");
const pk = p => { const d = String(p || "").replace(/[٠-٩]/g, c => "٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/\D+/g, ""); return d ? "p" + (d.length >= 9 ? d.slice(-9) : d) : ""; };
const nowIso = () => new Date().toISOString();
const val = async p => (await db.ref(p).once("value")).val();

class LimitReached extends Error {}
async function mail(to, subject, html){
  if(!to) return;
  if(sent >= MAX_MAILS_PER_RUN) throw new LimitReached("mail limit for this run");
  await transport.sendMail({ from: FROM, to, subject, html: wrap(html) });
  sent++;
  await new Promise(r => setTimeout(r, 250));
}
const notifyAdmin = (subject, body) =>
  mail(ADMIN_EMAIL, "[لجنة المهام] " + subject, `<div style="white-space:pre-wrap">${esc(body)}</div>`).catch(e => { if(e instanceof LimitReached) throw e; });

async function isLeaderUid(uid){
  try{
    const u = await admin.auth().getUser(uid);
    return !!(u.emailVerified && (await val("leaders/" + ek(u.email))));
  }catch(e){ return false; }
}
function logAct(up, type, details){
  up["activityLog/" + db.ref("activityLog").push().key] = { createdAt: nowIso(), type, details };
}
function msgTo(up, email, phone, name, type, message, source){
  const id = db.ref("messages").push().key;
  [email ? ek(email) : "", phone ? pk(phone) : ""].filter(Boolean).forEach(k => {
    up["messages/" + k + "/" + id] = { type, message, createdAt: nowIso(), source, name: name || "" };
  });
}

// ============ الأحداث ============
const LEADER_ONLY = new Set(["taskAdded", "assigned", "memberMessage", "ban"]);

async function handle(ev){
  if(LEADER_ONLY.has(ev.type) && !(await isLeaderUid(ev.by))) return; // نتجاهل أي حدث مزوّر
  switch(ev.type){
    case "claim":
    case "join": {
      if(!(await val(`claims/${ev.taskId}/${ev.role}`))) return;
      const pr = (await val(`claimPrivate/${ev.taskId}/${ev.role}`)) || {};
      const t = (await val("tasks/" + ev.taskId)) || {};
      const sub = ev.type === "claim" ? "حجز جديد" : "انضمام لفريق مهمة";
      const verb = ev.type === "claim" ? "حجز" : "انضم لفريق";
      await notifyAdmin(sub, `${ev.name} ${verb} مهمة "${t.title || ev.title}"\nالجوال: ${pr.phone || ""}\nالإيميل: ${pr.email || ""}`);
      return;
    }
    case "cancel": {
      const t = (await val("tasks/" + ev.taskId)) || {};
      await notifyAdmin("إلغاء حجز",
        `${ev.name} ألغى حجزه كـ${ev.role === "primary" ? "أساسي" : ev.role === "backup" ? "احتياطي" : "عضو"} لمهمة "${ev.title}"` + (ev.reason ? `\nالسبب: ${ev.reason}` : ""));
      if(ev.role === "primary" && t.title){
        // ترقية الاحتياطي إلى أساسي (إن لم يسبق أن تولّى بنفسه)
        let bpr = await val(`claimPrivate/${ev.taskId}/backup`);
        let bcl = await val(`claims/${ev.taskId}/backup`);
        if(bcl && !(await val(`claims/${ev.taskId}/primary`))){
          const up = {};
          up[`claims/${ev.taskId}/primary`] = bcl; up[`claims/${ev.taskId}/backup`] = null;
          up[`claimPrivate/${ev.taskId}/primary`] = bpr || null; up[`claimPrivate/${ev.taskId}/backup`] = null;
          [bpr && bpr.email ? ek(bpr.email) : "", bpr && bpr.phone ? pk(bpr.phone) : ""].filter(Boolean).forEach(k => {
            up[`contactClaims/${k}/${ev.taskId}~primary`] = true; up[`contactClaims/${k}/${ev.taskId}~backup`] = null;
          });
          if(bcl.uid){
            const sl = (await val("memberSlots/" + bcl.uid)) || {};
            ["s1", "s2"].forEach(k => { if(sl[k] === ev.taskId + "~backup") up[`memberSlots/${bcl.uid}/${k}`] = ev.taskId + "~primary"; });
          }
          await db.ref().update(up);
        }
        if(bpr && bpr.email && bcl){
          await mail(bpr.email, `أصبحت أساسيًا في مهمة: "${t.title}"`,
            `<p>مرحبًا ${esc(bcl.name)}،</p><p>ألغى الشخص الأساسي حجزه لمهمة "${esc(t.title)}"، وأصبحتَ الآن الأساسي المسؤول عن تنفيذها.</p>` +
            (t.dueDate ? `<p>التاريخ: ${esc(t.dueDate)}</p>` : ""));
        }
      }
      return;
    }
    case "taskAdded": {
      const t = await val("tasks/" + ev.taskId);
      if(!t) return;
      await notifyAdmin("تمت إضافة مهمة جديدة", `المهمة: ${t.title}` + (t.dueDate ? `\nالتاريخ: ${t.dueDate}` : ""));
      if(t.type === "individual" || t.type === "group"){
        const members = (await val("members")) || {};
        for(const uid of Object.keys(members)){
          const m = members[uid];
          if(m.bannedAt || !m.email) continue;
          const group = t.type === "group";
          await mail(m.email, group ? `مهمة جماعية جديدة: "${t.title}"` : `مهمة جديدة متاحة للحجز: "${t.title}"`,
            `<p>مرحبًا ${esc(m.name)}،<br>` + (group
              ? `تمت إضافة مهمة جماعية جديدة متاحة للانضمام إليها الآن (${esc(t.slots || 1)} خانات).</p>`
              : `تمت إضافة مهمة جديدة متاحة للحجز الآن.</p>`) +
            `<p>المهمة: ${esc(t.title)}</p>` + (t.dueDate ? `<p>التاريخ: ${esc(t.dueDate)}</p>` : ""));
        }
      }
      return;
    }
    case "assigned": {
      if(!ev.email) return;
      const team = /^member/.test(ev.role || "");
      await mail(ev.email, team ? `تم تعيينك لمهمة ضمن فريق: "${ev.title}"` : `تم تعيينك لمهمة: "${ev.title}"`,
        `<p>مرحبًا ${esc(ev.name)}،</p><p>${team ? "تم تعيينك ضمن فريق تنفيذ المهمة التالية." : "تم تعيينك لتنفيذ المهمة التالية."}</p>` +
        `<p>المهمة: ${esc(ev.title)}</p>` + (ev.dueDate ? `<p>التاريخ: ${esc(ev.dueDate)}</p>` : ""));
      return;
    }
    case "memberMessage": {
      if(!ev.email) return;
      const title = ev.msgType === "praise" ? "رسالة شكر وتقدير" : ev.msgType === "warning" ? "تنبيه من اللجنة التنفيذية" : "رسالة من اللجنة التنفيذية";
      await mail(ev.email, title,
        `<p>${ev.name ? "مرحبًا " + esc(ev.name) + "،<br>" : ""}وصلتك رسالة جديدة من اللجنة التنفيذية.</p>` +
        `<div style="font-size:14.5px;line-height:1.8;">${esc(ev.message).replace(/\n/g, "<br>")}</div>`);
      return;
    }
    case "ban": {
      if(!ev.email) return;
      await mail(ev.email, "تنبيه هام: تم استبعادك من حجز المهام",
        `<p>مرحبًا ${esc(ev.name)}،<br>نحيطك علمًا أنه تم استبعادك من إمكانية حجز مهام جديدة من قِبل اللجنة التنفيذية.</p>` +
        `<p>السبب: ${esc(ev.reason)}</p><p>في حال الرغبة بمراجعة هذا القرار، يُرجى التواصل المباشر مع اللجنة التنفيذية.</p>`);
      return;
    }
    case "feedback": {
      const f = await val("feedback/" + ev.feedbackId);
      if(f) await notifyAdmin("شكوى/اقتراح جديد (مجهول)", f.message);
      return;
    }
    case "registered": {
      const u = await admin.auth().getUser(ev.by);
      if(!u.emailVerified) return;
      await mail(u.email, "تم إنشاء عضويتك بنجاح",
        `<p>مرحبًا ${esc(ev.name || "")}،</p><p>تم تسجيل عضويتك بنجاح في نظام حجز مهام اللجنة التنفيذية. يمكنك الآن تسجيل الدخول مباشرة باستخدام إيميلك وكلمة المرور.</p>`);
      return;
    }
    case "deleteAuth": {
      const target = ev.target || ev.by;
      if(ev.target && !(await isLeaderUid(ev.by))) return;
      if(await val("members/" + target)) return; // العضوية ما زالت موجودة
      try{ await admin.auth().deleteUser(target); }catch(e){ /* قد يكون محذوفًا */ }
      return;
    }
    default: return;
  }
}

async function runEvents(){
  const snap = await db.ref("events").orderByChild("createdAt").limitToFirst(100).once("value");
  const items = [];
  snap.forEach(c => { items.push({ key: c.key, ev: c.val() }); });
  for(const { key, ev } of items){
    try{
      await handle(ev);
      await db.ref("events/" + key).remove();
    }catch(e){
      if(e instanceof LimitReached){ console.log("وصلنا حد الإرسال لهذه الجولة، البقية تُكمل لاحقًا."); break; }
      const attempts = (ev.attempts || 0) + 1;
      console.error("event failed", key, ev.type, e.message);
      if(attempts >= 5) await db.ref("events/" + key).remove();
      else await db.ref("events/" + key + "/attempts").set(attempts);
    }
  }
}

// ============ اليومي ============
const riyadhDate = (d = new Date()) => new Date(d.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function registerStrike(name, phone, email, taskTitle){
  const key = ek(email), up = {};
  let uid = null;
  try{ uid = (await admin.auth().getUserByEmail(email)).uid; }catch(e){ uid = null; }
  let rec, path;
  if(uid && (await val("members/" + uid))){
    path = "members/" + uid; rec = await val(path);
  }else{
    path = "strikes/" + key; rec = (await val(path)) || { name, phone, email, count: 0 };
  }
  const isMember = path.startsWith("members/");
  const count = (isMember ? (rec.cancelStrikes || 0) : (rec.count || 0)) + 1;
  up[path + (isMember ? "/cancelStrikes" : "/count")] = count;
  if(!isMember){ up[path + "/name"] = name; up[path + "/phone"] = phone; up[path + "/email"] = email; }

  if(count >= 2){
    if(!rec.bannedAt){
      up[path + "/bannedAt"] = nowIso();
      up[path + "/banReason"] = "تكرار عدم إنجاز المهام المحجوزة دون إلغائها (استبعاد تلقائي)";
      up["bannedEmails/" + key] = true;
      msgTo(up, email, phone, name, "excluded",
        `تم استبعادك من حجز المهام الجديدة بسبب تكرار عدم إنجاز مهمة محجوزة وعدم إلغائها قبل موعدها (${count} مرات)، وآخرها مهمة "${taskTitle}".`, "system");
      logAct(up, "استبعاد عضو", `${name} استُبعد تلقائيًا بعد ${count} مرات عدم إنجاز/إلغاء لمهامه`);
      await db.ref().update(up);
      await notifyAdmin("استبعاد تلقائي لعضو", `${name} (${phone} / ${email}) تم استبعاده تلقائيًا من الحجز بعد ${count} مرات عدم إنجاز مهمة محجوزة دون إلغائها.`);
      await mail(email, "تنبيه هام: تم استبعادك من حجز المهام", `<p>تم استبعادك من حجز المهام الجديدة بسبب تكرار عدم إنجاز مهمة محجوزة دون إلغائها.</p>`);
      return;
    }
    await db.ref().update(up);
    return;
  }
  msgTo(up, email, phone, name, "warning",
    `لم يتم إنجاز مهمة "${taskTitle}" التي حجزتها، ولم يتم إلغاء الحجز قبل موعدها. هذا تنبيه رقم ${count} بخصوص الالتزام بالمهام — في حال تكرار ذلك سيتم استبعادك تلقائيًا من الحجز.`, "system");
  logAct(up, "تحذير عدم إنجاز", `${name} تلقّى تحذيرًا بسبب عدم إنجاز/إلغاء مهمة "${taskTitle}" (المرة ${count})`);
  await db.ref().update(up);
  await mail(email, "تنبيه: التزامك بالمهام المحجوزة", `<p>لم يتم إنجاز مهمة "${esc(taskTitle)}" التي حجزتها. هذا تنبيه رقم ${count}.</p>`);
}

async function runDaily(){
  const today = riyadhDate(), tomorrow = addDays(today, 1);
  const [tasks, claims, priv, rstate] = await Promise.all([val("tasks"), val("claims"), val("claimPrivate"), val("reminderState")]);
  const bodyOf = (name, title, date, text) =>
    `<p>مرحبًا ${esc(name)}،<br>${text}</p><p>المهمة: ${esc(title)}</p><p>التاريخ: ${esc(date)}</p>` +
    `<p>يُرجى إنجاز المهمة في وقتها. شكرًا لك على تعاونك مع اللجنة التنفيذية.</p>`;
  for(const tid of Object.keys(claims || {})){
    const t = (tasks || {})[tid]; if(!t || t.archived) continue;
    for(const role of Object.keys(claims[tid])){
      if(!(role === "primary" || /^member/.test(role))) continue;
      const cl = claims[tid][role], pr = ((priv || {})[tid] || {})[role] || {};
      if(!pr.email) continue;
      const st = (((rstate || {})[tid]) || {})[role] || {};
      const set = (k) => db.ref(`reminderState/${tid}/${role}/${k}`).set(true);
      try{
        if(t.dueDate === tomorrow && !st.pre){
          await mail(pr.email, "تذكير: مهمتك غدًا — " + t.title, bodyOf(cl.name, t.title, tomorrow, "هذا تذكير بمهمتك غدًا.")); await set("pre");
        }
        if(t.dueDate === today && !st.today){
          await mail(pr.email, "تذكير: مهمتك اليوم — " + t.title, bodyOf(cl.name, t.title, today, "هذا تذكير بمهمتك اليوم.")); await set("today");
        }
        if(t.dueDate && t.dueDate < today && !cl.proofUrl){
          if(!st.proof){
            await mail(pr.email, "تذكير: رفع إثبات إنجاز — " + t.title,
              `<p>مرحبًا ${esc(cl.name)}،<br>لاحظنا أن موعد مهمتك قد مرّ ولم يصلنا بعد إثبات إنجازها.</p><p>المهمة: ${esc(t.title)}</p>` +
              `<p>في حال إتمامها، يُرجى الدخول إلى «تسجيل الدخول» في الموقع ورفع صورة الإثبات. وفي حال وجود أي عائق، يُرجى إبلاغ اللجنة.</p>`);
            await set("proof");
          }
          if(!st.strike){ await set("strike"); await registerStrike(cl.name, pr.phone, pr.email, t.title); }
        }
      }catch(e){ if(e instanceof LimitReached) throw e; console.error("reminder failed", tid, role, e.message); }
    }
  }
  await archiveMonthlyHero(today);
}

async function archiveMonthlyHero(today){
  const months = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
  const [y, m] = today.split("-").map(Number);
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
  const label = months[pm - 1] + " " + py, ym = `${py}-${String(pm).padStart(2, "0")}`;
  const heroes = (await val("monthlyHeroes")) || {};
  if(Object.values(heroes).some(h => h.month === label)) return;
  const claims = (await val("claims")) || {};
  const counts = {};
  Object.values(claims).forEach(roles => Object.values(roles).forEach(c => {
    if(!c.claimedAt || !c.proofUrl) return; // تُحتسب المهام المنجزة فقط
    if(riyadhDate(new Date(c.claimedAt)).slice(0, 7) === ym) counts[c.name] = (counts[c.name] || 0) + 1;
  }));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if(!top) return;
  const up = {};
  up["monthlyHeroes/" + db.ref("monthlyHeroes").push().key] = { month: label, name: top[0], task_count: top[1], registeredAt: nowIso() };
  logAct(up, "أرشفة بطل الشهر", `${top[0]} — ${label} (${top[1]} مهمة)`);
  await db.ref().update(up);
}

(async () => {
  const mode = process.argv[2] || "events";
  try{
    if(mode === "events" || mode === "all") await runEvents();
    if(mode === "daily" || mode === "all") await runDaily();
    console.log(`تم. الإيميلات المرسلة: ${sent}`);
  }catch(e){
    if(e instanceof LimitReached) console.log("وصلنا حد الإرسال لهذه الجولة.");
    else { console.error(e); process.exitCode = 1; }
  }
  process.exit(process.exitCode || 0);
})();
