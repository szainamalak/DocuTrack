require("dotenv").config();
const express=require("express"),webpush=require("web-push");
const app=express();app.use(express.json());
const subscriptions=new Map(),documents=new Map();
webpush.setVapidDetails(process.env.VAPID_SUBJECT,process.env.VAPID_PUBLIC_KEY,process.env.VAPID_PRIVATE_KEY);
app.post("/subscribe",(q,s)=>{const{id,subscription}=q.body;if(!id||!subscription)return s.status(400).json({error:"Missing data"});subscriptions.set(id,subscription);s.json({ok:true})});
app.post("/documents",(q,s)=>{const{ownerId,documents:docs}=q.body;if(!ownerId)return s.status(400).json({error:"Missing ownerId"});documents.set(ownerId,docs||[]);s.json({ok:true})});
function days(d){return Math.ceil((new Date(d+"T23:59:59")-new Date())/86400000)}
async function sendDue(){for(const[id,docs]of documents){const sub=subscriptions.get(id);if(!sub)continue;for(const d of docs||[]){const n=days(d.expiryDate);if([7,3,2,1,0].includes(n)){try{await webpush.sendNotification(sub,JSON.stringify({title:"DocuTrack expiry reminder",body:`${d.name} ${n===0?"expires today":"expires in "+n+" day(s)"}.`}))}catch(e){if([404,410].includes(e.statusCode))subscriptions.delete(id)}}}}}
setInterval(sendDue,3600000);app.listen(process.env.PORT||3000,()=>console.log("DocuTrack push server running"));
