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
// ===== قالب الإيميل: شعار + ألوان النادي + توقيع اللجنة =====
const fs = require("fs"), path = require("path");
let LOGO = null; try{ LOGO = fs.readFileSync(path.join(__dirname, "logo.png")); }catch(e){ LOGO = null; }
const C = { indigo: "#1F3649", terracotta: "#C1481E", sand: "#F6F1EA", ink: "#2B2B2B", muted: "#7A7268" };
const fmtDate = d => { try{ return new Date(d + "T12:00:00Z").toLocaleDateString("ar-SA-u-ca-gregory-nu-arab", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Riyadh" }); }catch(e){ return d; } };
const greet = name => name ? `<p style="margin:0 0 14px;font-size:16px;"><b>مرحبًا ${esc(name)}،</b></p>` : "";
const para = t => `<p style="margin:0 0 14px;">${t}</p>`;
const taskBox = (title, date, extra) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 16px;"><tr><td style="background:#FBF7F1;border:1px solid #E7DDCF;border-right:4px solid ${C.terracotta};border-radius:10px;padding:12px 16px;line-height:1.9;">` +
  `<div style="color:${C.muted};font-size:12px;">المهمة</div><div style="font-size:16px;font-weight:bold;color:${C.indigo};">${esc(title)}</div>` +
  (date ? `<div style="color:${C.muted};font-size:12px;margin-top:8px;">الموعد</div><div style="font-size:14.5px;">${esc(fmtDate(date))}</div>` : "") + (extra || "") + `</td></tr></table>`;
const msgBox = (text, tone) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 16px;"><tr><td style="background:#FBF7F1;border:1px solid #E7DDCF;border-right:4px solid ${tone === "praise" ? "#2E8B57" : tone === "warning" ? C.terracotta : C.indigo};border-radius:10px;padding:14px 16px;font-size:15px;line-height:2;">${esc(text).replace(/\n/g, "<br>")}</td></tr></table>`;
const wrap = (html, subject) => `<!DOCTYPE html><html dir="rtl" lang="ar"><body style="margin:0;padding:0;background:${C.sand};">` +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.sand};padding:20px 10px;"><tr><td align="center">` +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #E7DDCF;font-family:Tahoma,Arial,sans-serif;color:${C.ink};direction:rtl;text-align:right;">` +
  `<tr><td align="center" style="background:${C.indigo};padding:22px 16px 16px;border-bottom:4px solid ${C.terracotta};">` +
  (LOGO ? `<img src="cid:clublogo" width="72" height="72" alt="شعار النادي" style="display:block;margin:0 auto 10px;border-radius:50%;background:#fff;">` : "") +
  `<div style="color:#ffffff;font-size:18px;font-weight:bold;">نادي الإرشاد السياحي</div><div style="color:#E9D9C4;font-size:13px;margin-top:2px;">اللجنة التنفيذية</div></td></tr>` +
  `<tr><td style="padding:24px 22px 8px;font-size:15px;line-height:1.9;">${html}</td></tr>` +
  `<tr><td style="padding:6px 22px 22px;font-size:15px;line-height:1.9;"><div style="border-top:1px solid #EFE6D8;padding-top:14px;">مع خالص التحية،<br><b style="color:${C.indigo};">اللجنة التنفيذية</b><br><span style="color:${C.muted};font-size:13px;">نادي الإرشاد السياحي</span></div></td></tr>` +
  `<tr><td style="background:#FBF7F1;padding:12px 22px;color:${C.muted};font-size:11.5px;line-height:1.8;text-align:center;">هذه رسالة آلية من نظام حجز مهام اللجنة التنفيذية، يُرجى عدم الرد عليها مباشرة.</td></tr>` +
  `</table></td></tr></table></body></html>`;
const ek = e => String(e || "").trim().toLowerCase().replace(/\s+/g, "").replace(/[.#$\[\]\/]/g, ",");
const pk = p => { const d = String(p || "").replace(/[٠-٩]/g, c => "٠١٢٣٤٥٦٧٨٩".indexOf(c)).replace(/\D+/g, ""); return d ? "p" + (d.length >= 9 ? d.slice(-9) : d) : ""; };
const nowIso = () => new Date().toISOString();
const { fbStatsCompute } = require("./stats_core");
const val = async p => (await db.ref(p).once("value")).val();

class LimitReached extends Error {}
async function mail(to, subject, html){
  if(!to) return;
  if(sent >= MAX_MAILS_PER_RUN) throw new LimitReached("mail limit for this run");
  await transport.sendMail({ from: FROM, to, subject, html: wrap(html, subject), attachments: LOGO ? [{ filename: "logo.png", content: LOGO, cid: "clublogo" }] : [] });
  sent++;
  await new Promise(r => setTimeout(r, 250));
}
const notifyAdmin = (subject, body) =>
  mail(ADMIN_EMAIL, "[لجنة المهام] " + subject, para(`<span style="white-space:pre-wrap">${esc(body)}</span>`)).catch(e => { if(e instanceof LimitReached) throw e; });

async function isLeaderUid(uid){
  try{
    const u = await admin.auth().getUser(uid);
    return !!(u.emailVerified && (await val("leaders/" + ek(u.email))));
  }catch(e){ return false; }
}
async function isPresidentUid(uid){
  try{
    const u = await admin.auth().getUser(uid);
    const l = u.emailVerified ? await val("leaders/" + ek(u.email)) : null;
    return !!(l && l.role === "president");
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
const LEADER_ONLY = new Set(["taskAdded", "assigned", "memberMessage", "presidentMessage", "ban"]);

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
            greet(bcl.name) + para("ألغى الشخص الأساسي حجزه لهذه المهمة، وأصبحتَ الآن الأساسي المسؤول عن تنفيذها.") + taskBox(t.title, t.dueDate));
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
            greet(m.name) + para(group
              ? `تمت إضافة مهمة جماعية جديدة متاحة للانضمام إليها الآن (${esc(t.slots || 1)} خانات).`
              : `تمت إضافة مهمة جديدة متاحة للحجز الآن.`) +
            taskBox(t.title, t.dueDate) + para("للحجز، يُرجى الدخول إلى الموقع من الحساب الشخصي واختيار المهمة."));
        }
      }
      return;
    }
    case "assigned": {
      if(!ev.email) return;
      const team = /^member/.test(ev.role || "");
      await mail(ev.email, team ? `تم تعيينك لمهمة ضمن فريق: "${ev.title}"` : `تم تعيينك لمهمة: "${ev.title}"`,
        greet(ev.name) + para(team ? "تم تعيينك ضمن فريق تنفيذ المهمة التالية." : "تم تعيينك لتنفيذ المهمة التالية.") + taskBox(ev.title, ev.dueDate));
      return;
    }
    case "memberMessage": {
      if(!ev.email) return;
      const title = ev.msgType === "praise" ? "رسالة شكر وتقدير" : ev.msgType === "warning" ? "تنبيه من اللجنة التنفيذية" : "رسالة من اللجنة التنفيذية";
      await mail(ev.email, title,
        greet(ev.name) + para(ev.msgType === "praise" ? "يسرّنا أن نشاركك رسالة الشكر والتقدير التالية من اللجنة التنفيذية:" : ev.msgType === "warning" ? "وصلك التنبيه التالي من اللجنة التنفيذية:" : "وصلتك رسالة جديدة من اللجنة التنفيذية:") + msgBox(ev.message, ev.msgType));
      return;
    }
    case "presidentMessage": {
      if(!ev.email) return;
      if(!(await isPresidentUid(ev.by))) return;
      const title = ev.msgType === "praise" ? "رسالة شكر من رئيس النادي" : ev.msgType === "warning" ? "تنبيه من رئيس النادي" : "رسالة من رئيس النادي";
      await mail(ev.email, title,
        greet(ev.name) + para(ev.msgType === "praise" ? `يسرّنا أن نشاركك رسالة الشكر والتقدير التالية من ${esc(ev.from || "رئيس النادي")}:` : ev.msgType === "warning" ? `وصلك التنبيه التالي من ${esc(ev.from || "رئيس النادي")}:` : `وصلتك رسالة جديدة من ${esc(ev.from || "رئيس النادي")}:`) + msgBox(ev.message, ev.msgType));
      return;
    }
    case "ban": {
      if(!ev.email) return;
      await mail(ev.email, "تنبيه هام: تم استبعادك من حجز المهام",
        greet(ev.name) + para("نحيطك علمًا أنه تم استبعادك من إمكانية حجز مهام جديدة من قِبل اللجنة التنفيذية.") + msgBox("السبب: " + (ev.reason || ""), "warning") + para("في حال الرغبة بمراجعة هذا القرار، يُرجى التواصل المباشر مع اللجنة التنفيذية."));
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
        greet(ev.name) + para("يسعدنا انضمامك! تم تسجيل عضويتك بنجاح في نظام حجز مهام اللجنة التنفيذية.") + para("يمكنك الآن تسجيل الدخول مباشرة باستخدام إيميلك وكلمة المرور، واختيار المهام المناسبة لك."));
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
      await mail(email, "تنبيه هام: تم استبعادك من حجز المهام", greet(name) + para("نحيطك علمًا أنه تم استبعادك من حجز المهام الجديدة بسبب تكرار عدم إنجاز مهمة محجوزة دون إلغائها.") + para("في حال الرغبة بمراجعة هذا القرار، يُرجى التواصل المباشر مع اللجنة التنفيذية."));
      return;
    }
    await db.ref().update(up);
    return;
  }
  msgTo(up, email, phone, name, "warning",
    `لم يتم إنجاز مهمة "${taskTitle}" التي حجزتها، ولم يتم إلغاء الحجز قبل موعدها. هذا تنبيه رقم ${count} بخصوص الالتزام بالمهام — في حال تكرار ذلك سيتم استبعادك تلقائيًا من الحجز.`, "system");
  logAct(up, "تحذير عدم إنجاز", `${name} تلقّى تحذيرًا بسبب عدم إنجاز/إلغاء مهمة "${taskTitle}" (المرة ${count})`);
  await db.ref().update(up);
  await mail(email, "تنبيه: التزامك بالمهام المحجوزة", greet(name) + para(`لم يتم إنجاز مهمة محجوزة باسمك ولم يُلغَ حجزها قبل موعدها. هذا التنبيه رقم ${count} بخصوص الالتزام بالمهام، وفي حال تكراره سيتم استبعادك تلقائيًا من الحجز.`) + taskBox(taskTitle));
}

async function runDaily(){
  const today = riyadhDate(), tomorrow = addDays(today, 1);
  const [tasks, claims, priv, rstate] = await Promise.all([val("tasks"), val("claims"), val("claimPrivate"), val("reminderState")]);
  const bodyOf = (name, title, date, text) =>
    greet(name) + para(text) + taskBox(title, date) + para("يُرجى إنجاز المهمة في وقتها. شكرًا لك على تعاونك مع اللجنة التنفيذية.");
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
              greet(cl.name) + para("لاحظنا أن موعد مهمتك قد مرّ ولم يصلنا بعد إثبات إنجازها.") + taskBox(t.title, t.dueDate) +
              para("في حال إتمامها، يُرجى الدخول إلى «تسجيل الدخول» في الموقع ورفع صورة الإثبات. وفي حال وجود أي عائق، يُرجى إبلاغ اللجنة."));
            await set("proof");
          }
          if(!st.strike){ await set("strike"); await registerStrike(cl.name, pr.phone, pr.email, t.title); }
        }
      }catch(e){ if(e instanceof LimitReached) throw e; console.error("reminder failed", tid, role, e.message); }
    }
  }
  await archiveMonthlyHero(today);
  try{ await runMonthlyReport(today); }catch(e){ if(e instanceof LimitReached) throw e; console.error("monthly report failed", e.message); }
}


// ملخص شهري لرئيس النادي: يُرسل مرة واحدة في اليوم الأول من كل شهر
async function runMonthlyReport(today){
  if(today.slice(8, 10) !== "01") return;
  const months = ["يناير","فبراير","مارس","أبريل","مايو","يونيو","يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر"];
  const lastDay = addDays(today, -1), ym = lastDay.slice(0, 7);
  if(await val("reportState/" + ym)) return;
  const leaders = (await val("leaders")) || {};
  const pres = Object.keys(leaders).map(k => ({ k, l: leaders[k] || {} })).filter(x => x.l.role === "president")
    .map(x => ({ name: x.l.name || "", email: x.l.email || x.k.replace(/,/g, ".") })).filter(x => /@/.test(x.email));
  if(!pres.length) return;
  const [tasks, claims, notes, members] = await Promise.all([val("tasks"), val("claims"), val("taskNotes"), val("members")]);
  const ls = await db.ref("activityLog").orderByChild("createdAt").limitToLast(6000).get();
  const st = fbStatsCompute({ tasks, claims, notes, members, log: ls.val() || {} }, lastDay, 6);
  const m = st.months[st.months.length - 1], p = st.months[st.months.length - 2] || {};
  const label = months[+ym.slice(5, 7) - 1] + " " + ym.slice(0, 4);
  const esc = t => String(t == null ? "" : t).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const d = (a, b) => (a == null || b == null) ? "" : (a === b ? " (دون تغيير)" : ` (${a > b ? "▲" : "▼"} ${Math.round(Math.abs(a - b) * 10) / 10} عن الشهر السابق)`);
  const row = (t, v, x) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${t}</td><td style="padding:6px 10px;border-bottom:1px solid #eee"><b>${v}</b>${x || ""}</td></tr>`;
  const lead = m.leaders.length ? m.leaders.map(x => `${esc(x.name)}: رفع ${x.added} مهمة، وكتب ${x.notes} ملاحظة`).join("<br>") : "لا توجد مهام مرفوعة";
  const noteList = [];
  m.doneTasks.forEach(t => t.notes.forEach(n => noteList.push(`<li><b>${esc(n.by)}</b> على «${esc(t.title)}»: ${esc(n.text)}</li>`)));
  const html = `<div><h2 style="margin:0 0 12px;color:${C.indigo};font-size:18px;">ملخص أداء النادي — ${label}</h2><table style="border-collapse:collapse;width:100%">` +
    row("مهام أُضيفت", m.added, d(m.added, p.added)) + row("حجوزات", m.bookings, d(m.bookings, p.bookings)) +
    row("مهام منجزة (إثباتات)", m.proofs, d(m.proofs, p.proofs)) +
    row("نسبة إنجاز مهام الشهر", m.rate == null ? "—" : m.rate + "٪", ` (${m.dueDone} من ${m.due})`) +
    row("إلغاءات الحجز", m.cancels, d(m.cancels, p.cancels) + (m.cancelRate == null ? "" : ` — نسبة الإلغاء ${m.cancelRate}٪`)) +
    row("أعضاء نشطون", m.active, d(m.active, p.active)) + row("أعضاء جدد", m.registered, d(m.registered, p.registered)) +
    row("متوسط زمن الإنجاز", m.avgHours == null ? "—" : m.avgHours + " ساعة") +
    row("إجمالي أعضاء النادي", st.snapshot.members, st.snapshot.banned ? ` (${st.snapshot.banned} مستبعدون من الحجز)` : "") + row("مهام مفتوحة حاليًا", st.snapshot.open, ` (${st.snapshot.unbooked} دون حجز)`) +
    row("مهام تجاوزت موعدها دون إنجاز", st.snapshot.overdue) +
    `</table><p><b>القادة هذا الشهر:</b><br>${lead}</p>` +
    (noteList.length ? `<p><b>ملاحظات القادة على المهام المكتملة:</b></p><ul>${noteList.join("")}</ul>` : "") +
    `<p style="color:#777;font-size:12px">للتفاصيل والمقارنة بين الأشهر، يُرجى الدخول إلى الموقع من الحساب الشخصي (صفحة الرئيس).</p></div>`;
  for(const x of pres) await mail(x.email, `ملخص أداء النادي — ${label}`, greet(x.name) + html);
  await db.ref("reportState/" + ym).set({ sentAt: nowIso() });
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
    if(!c.claimedAt || !c.proofUrl || c.memberGone) return; // تُحتسب المهام المنجزة فقط، دون الأعضاء المحذوفين
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
