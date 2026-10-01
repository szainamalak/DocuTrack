const DB_NAME="DocuTrackDB", STORE="documents";
let docs=[];
const $=id=>document.getElementById(id);

function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=()=>req.result.createObjectStore(STORE,{keyPath:"id",autoIncrement:true});
    req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
  });
}
async function dbAll(){
  const db=await openDB(); return new Promise((res,rej)=>{const r=db.transaction(STORE).objectStore(STORE).getAll();r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
}
async function dbAdd(doc){
  const db=await openDB(); return new Promise((res,rej)=>{const r=db.transaction(STORE,"readwrite").objectStore(STORE).add(doc);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
}
async function dbDelete(id){
  const db=await openDB(); return new Promise((res,rej)=>{const r=db.transaction(STORE,"readwrite").objectStore(STORE).delete(id);r.onsuccess=()=>res();r.onerror=()=>rej(r.error)});
}
function daysLeft(date){return Math.ceil((new Date(date+"T23:59:59")-new Date())/86400000)}
function status(d){
  const n=daysLeft(d.expiryDate);
  if(n<0)return "expired"; if(n<=1)return "urgent"; if(n<=7)return "soon"; return "safe";
}
function statusText(d){
  const n=daysLeft(d.expiryDate);
  if(n<0)return `Expired ${Math.abs(n)} day${Math.abs(n)==1?"":"s"} ago`;
  if(n===0)return "Expires today";
  if(n===1)return "Expires tomorrow";
  return `${n} days left`;
}
function icon(cat){return {Identity:"ID",Education:"ED",Finance:"₹",Vehicle:"VE",Travel:"TR",Insurance:"IN",Other:"DOC"}[cat]||"DOC"}
function fmt(date){return new Date(date+"T00:00:00").toLocaleDateString("en-IN",{day:"2-digit",month:"short",year:"numeric"})}
function render(){
  const sorted=[...docs].sort((a,b)=>new Date(a.expiryDate)-new Date(b.expiryDate));
  const expired=docs.filter(d=>status(d)==="expired").length;
  const soon=docs.filter(d=>["soon","urgent"].includes(status(d))).length;
  const safe=docs.length-expired-soon;
  $("totalCount").textContent=docs.length; $("safeCount").textContent=safe; $("soonCount").textContent=soon; $("expiredCount").textContent=expired;
  $("safePercent").textContent=docs.length?Math.round(safe/docs.length*100)+"%":"100%";
  const attention=sorted.filter(d=>["soon","urgent","expired"].includes(status(d))).slice(0,5);
  $("attentionList").className=attention.length?"document-list":"document-list empty-state";
  $("attentionList").innerHTML=attention.length?attention.map(row).join(""):`<div class="empty-icon">✓</div><h4>You're all caught up</h4><p>Add a document to start tracking expiry dates.</p>`;
  const recent=[...docs].sort((a,b)=>b.created-a.created).slice(0,4);
  $("recentList").className=recent.length?"document-list":"document-list empty-state";
  $("recentList").innerHTML=recent.length?recent.map(row).join(""):"<p>No documents yet.</p>";
  renderAll(); renderTimeline(); checkAlerts();
}
function row(d){
  return `<div class="doc-row"><div class="doc-avatar">${icon(d.category)}</div><div class="doc-info"><strong>${esc(d.name)}</strong><small>${esc(d.category)} · Expires ${fmt(d.expiryDate)}</small></div><span class="status-pill ${status(d)}">${status(d)==="expired"?"Expired":statusText(d)}</span><div class="days">${d.fileName?"📎 Attached":""}</div></div>`;
}
function renderAll(){
  const q=($("searchInput")?.value||"").toLowerCase(), f=$("filterSelect")?.value||"all", c=$("categorySelect")?.value||"all";
  let list=docs.filter(d=>(d.name+" "+d.category).toLowerCase().includes(q)&&(f==="all"||status(d)===f||(f==="soon"&&status(d)==="urgent"))&&(c==="all"||d.category===c)).sort((a,b)=>new Date(a.expiryDate)-new Date(b.expiryDate));
  $("allDocuments").innerHTML=list.length?list.map(card).join(""):`<div class="empty-state" style="grid-column:1/-1"><div class="empty-icon">⌕</div><h4>No matching documents</h4><p>Try another search or filter.</p></div>`;
}
function card(d){
  return `<article class="doc-card"><div class="doc-card-top"><div class="doc-avatar">${icon(d.category)}</div><span class="status-pill ${status(d)}">${status(d)==="expired"?"Expired":statusText(d)}</span></div><h4>${esc(d.name)}</h4><div class="cat">${esc(d.category)}</div><div class="expiry"><span>Expiry date</span><strong>${fmt(d.expiryDate)}</strong></div>${d.notes?`<p style="font-size:10px;color:#738096;line-height:1.5;margin:10px 0 0">${esc(d.notes)}</p>`:""}<div class="card-actions">${d.fileData?`<button class="small-btn" onclick="openFile(${d.id})">↗ Open file</button>`:""}<button class="small-btn danger" onclick="removeDoc(${d.id})">Delete</button></div></article>`;
}
function renderTimeline(){
  const list=[...docs].sort((a,b)=>new Date(a.expiryDate)-new Date(b.expiryDate));
  $("timeline").innerHTML=list.length?list.map(d=>`<div class="time-item"><div class="time-date">${fmt(d.expiryDate)} · ${statusText(d)}</div><h4>${esc(d.name)}</h4><p>${esc(d.category)}${d.fileName?" · 📎 "+esc(d.fileName):""}</p></div>`).join(""):`<div class="empty-state"><h4>No timeline yet</h4><p>Add documents to see their expiry schedule.</p></div>`;
}
function esc(s){return String(s||"").replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
async function removeDoc(id){if(confirm("Delete this document record?")){await dbDelete(id);docs=await dbAll();render();toast("Document deleted.")}}
async function openFile(id){const d=docs.find(x=>x.id===id);if(!d?.fileData)return;const a=document.createElement("a");a.href=d.fileData;a.download=d.fileName||d.name;a.target="_blank";a.click()}
function toast(msg,warning=false){const t=$("toast");t.textContent=msg;t.className="toast show"+(warning?" warning":"");setTimeout(()=>t.className="toast hidden",3500)}
function openModal(){$("modalBackdrop").classList.remove("hidden")}
function closeModal(){$("modalBackdrop").classList.add("hidden");$("documentForm").reset();$("fileLabel").textContent="📎 Click to choose a PDF, image or document"}
function showView(name){
  document.querySelectorAll(".view").forEach(v=>v.classList.add("hidden"));$(name+"View").classList.remove("hidden");
  document.querySelectorAll(".nav-item").forEach(n=>n.classList.toggle("active",n.dataset.view===name));
  if(name==="dashboard")$("pageTitle").textContent="Good evening 👋"; else if(name==="documents")$("pageTitle").textContent="Your Documents"; else $("pageTitle").textContent="Expiry Timeline";
}
function checkAlerts(){
 docs.forEach(d=>{
  const n=daysLeft(d.expiryDate);
  if([7,3,2,1,0].includes(n)){
   const key=`alert-${d.id}-${d.expiryDate}-${n}`;
   if(!localStorage.getItem(key)){
    localStorage.setItem(key,"1");
    toast(`🔔 ${d.name}: ${n===0?"expires today":n+" day(s) until expiry"}`,true);
    if("Notification" in window && Notification.permission==="granted")
      new Notification("DocuTrack expiry alert",{body:`${d.name} ${n===0?"expires today":"expires in "+n+" day(s)"}.`,icon:"icon.svg",tag:key});
   }
  }
 });
 if("Notification" in window){
  $("storageStatus").textContent=Notification.permission==="granted"?"Enabled ✓":"Not enabled";
  $("storageDetail").textContent=Notification.permission==="granted"?"7 / 3 / 2 / 1 day alerts":"Tap 🔔 to enable";
 }
}
$("addBtn").onclick=openModal;$("heroAdd").onclick=openModal;$("addBtn2").onclick=openModal;$("closeModal").onclick=closeModal;
$("modalBackdrop").onclick=e=>{if(e.target.id==="modalBackdrop")closeModal()};
$("fileInput").onchange=e=>{const f=e.target.files[0];$("fileLabel").textContent=f?"📎 "+f.name:"📎 Click to choose a PDF, image or document"};
document.querySelectorAll(".nav-item").forEach(n=>n.onclick=()=>showView(n.dataset.view));
document.querySelectorAll("[data-view-target]").forEach(b=>b.onclick=()=>showView(b.dataset.viewTarget));
["searchInput","filterSelect","categorySelect"].forEach(id=>$(id)?.addEventListener("input",renderAll));
async function enableReminders(){
 if(!("Notification" in window)){toast("This browser does not support notifications.");return}
 const p=await Notification.requestPermission();
 if(p==="granted"){localStorage.setItem("docutrackNotifications","enabled");toast("Reminders enabled ✓");checkAlerts();}
 else toast("Please allow notifications in browser settings.");
}
$("notificationBtn").onclick=enableReminders;
$("documentForm").onsubmit=async e=>{
  e.preventDefault();const f=new FormData(e.target);const file=$("fileInput").files[0];
  let fileData=null,fileName=null,fileType=null;
  if(file){fileData=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(file)});fileName=file.name;fileType=file.type}
  await dbAdd({name:f.get("name"),category:f.get("category"),issueDate:f.get("issueDate"),expiryDate:f.get("expiryDate"),notes:f.get("notes"),fileData,fileName,fileType,created:Date.now()});
  docs=await dbAll();closeModal();render();toast("Document saved successfully ✓");
};
$("demoBtn").onclick=async()=>{
  if(docs.length&&!confirm("Demo data will be added to your existing records. Continue?"))return;
  const today=new Date(); const addDays=n=>{const d=new Date(today);d.setDate(d.getDate()+n);return d.toISOString().slice(0,10)};
  const samples=[["Passport","Identity",addDays(185)],["College ID Card","Education",addDays(7)],["Vehicle Insurance","Insurance",addDays(3)],["Driving Licence","Vehicle",addDays(62)],["Travel Insurance","Travel",addDays(1)],["Bank FD","Finance",addDays(-2)]];
  for(const [name,category,expiryDate] of samples)await dbAdd({name,category,expiryDate,issueDate:"",notes:"Demo record for presentation",created:Date.now()});
  docs=await dbAll();render();toast("Demo records loaded — ready for your presentation!");
};
(async()=>{docs=await dbAll();render();})();
