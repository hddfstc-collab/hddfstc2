import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, query, where,
  runTransaction, serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const state = { items: [], settings: null, cart: new Map(), filter: "all", search: "" };
const el = id => document.getElementById(id);
const itemGrid = el("itemGrid"), emptyState = el("emptyState"), drawer = el("cartDrawer");

const defaultSettings = {
  enabled: true, notice: "", weekdays: [0,1,2,3,4], daysAhead: 14,
  cutoffHours: 2, cancelHours: 2,
  times: [{ time: "10:00", capacity: 3 }, { time: "11:00", capacity: 3 }, { time: "14:00", capacity: 3 }, { time: "15:00", capacity: 3 }]
};

function toast(message) {
  const box = el("toast"); box.textContent = message; box.classList.add("show");
  setTimeout(() => box.classList.remove("show"), 2400);
}
function formatQty(qty, item) {
  const packQty = Math.max(1, Number(item.packQty || 1));
  const unit = item.unit || "개", pack = item.packUnit || "박스";
  if (packQty <= 1) return `${qty.toLocaleString()}${unit}`;
  const boxes = Math.floor(qty / packQty), rem = qty % packQty;
  if (boxes && rem) return `${boxes}${pack} ${rem}${unit}`;
  return boxes ? `${boxes}${pack}` : `${rem}${unit}`;
}
function availableQty(item) {
  return Math.max(0, Number(item.stock || 0) - Number(item.reservedQty || 0));
}
function reservable(item) {
  return Boolean(item.active) && Boolean(item.reservable) && availableQty(item) > 0;
}
function renderItems() {
  const term = state.search.toLowerCase();
  const list = state.items.filter(item => {
    const match = !term || String(item.name || "").toLowerCase().includes(term);
    const filter = state.filter === "all" ||
      (state.filter === "reservable" && reservable(item)) ||
      (state.filter === "available" && Number(item.stock || 0) > 0);
    return match && filter;
  });
  el("resultCount").textContent = `${list.length}개 품목`;
  emptyState.hidden = list.length > 0;
  itemGrid.innerHTML = list.map(item => {
    const stock = Number(item.stock || 0), available = availableQty(item);
    const buttonText = !item.reservable ? "재고 확인만 가능" : available <= 0 ? "예약 가능수량 없음" : "예약하기";
    return `<article class="item-card">
      <div class="item-card-top"><h4>${escapeHtml(item.name)}</h4><span class="stock-badge ${stock<=0?'soldout':''}">${stock<=0?'품절':'재고 있음'}</span></div>
      <div class="item-meta"><div>현재고<strong>${stock.toLocaleString()}${escapeHtml(item.unit||'개')}</strong></div><div>예약가능<strong>${item.reservable?available.toLocaleString():'-'}</strong></div></div>
      <div class="item-card-footer"><div class="availability">${item.reservable ? `1회 상한 ${item.reservationMaxQty || '현재고'}${item.unit||'개'} · ${item.reservationUnit||'박스+낱개'}` : '이 품목은 예약 대상이 아닙니다.'}</div>
      <button class="reserve-button" data-add="${item.id}" ${reservable(item)?'':'disabled'}>${buttonText}</button></div>
    </article>`;
  }).join("");
  document.querySelectorAll("[data-add]").forEach(btn => btn.addEventListener("click", () => addToCart(btn.dataset.add)));
}
function addToCart(id) {
  const item = state.items.find(x => x.id === id); if (!item) return;
  const current = state.cart.get(id) || { item, qty: 0 };
  const step = item.reservationUnit === "박스만" ? Math.max(1,Number(item.packQty||1)) : 1;
  const next = current.qty + step;
  const max = Number(item.reservationMaxQty || availableQty(item));
  if (next > Math.min(max, availableQty(item))) return toast("예약 가능수량 또는 1회 상한을 초과했습니다.");
  state.cart.set(id, { item, qty: next }); renderCart(); openCart();
}
function changeQty(id, delta) {
  const row = state.cart.get(id); if (!row) return;
  const step = row.item.reservationUnit === "박스만" ? Math.max(1,Number(row.item.packQty||1)) : 1;
  const next = row.qty + delta * step;
  if (next <= 0) state.cart.delete(id);
  else {
    const max = Number(row.item.reservationMaxQty || availableQty(row.item));
    if (next > Math.min(max, availableQty(row.item))) return toast("예약 상한을 초과했습니다.");
    row.qty = next;
  }
  renderCart();
}
function renderCart() {
  const rows = [...state.cart.values()];
  el("cartCount").textContent = rows.length;
  el("summaryKinds").textContent = `${rows.length}종`;
  el("summaryQty").textContent = `${rows.reduce((s,x)=>s+x.qty,0).toLocaleString()}개`;
  el("cartItems").innerHTML = rows.length ? rows.map(({item,qty}) => `<div class="cart-row">
    <div><h4>${escapeHtml(item.name)}</h4><p>${formatQty(qty,item)} · 낱개환산 ${qty.toLocaleString()}${escapeHtml(item.unit||'개')}</p><button class="remove-button" data-remove="${item.id}">삭제</button></div>
    <div class="qty-control"><button type="button" data-minus="${item.id}">−</button><strong>${qty.toLocaleString()}</strong><button type="button" data-plus="${item.id}">+</button></div>
  </div>`).join("") : `<div class="cart-empty">예약할 품목을 담아주세요.</div>`;
  document.querySelectorAll("[data-minus]").forEach(b=>b.onclick=()=>changeQty(b.dataset.minus,-1));
  document.querySelectorAll("[data-plus]").forEach(b=>b.onclick=()=>changeQty(b.dataset.plus,1));
  document.querySelectorAll("[data-remove]").forEach(b=>b.onclick=()=>{state.cart.delete(b.dataset.remove);renderCart();});
  el("submitReservation").disabled = rows.length === 0 || !state.settings?.enabled;
}
function openCart(){ drawer.classList.add("open"); drawer.setAttribute("aria-hidden","false"); }
function closeCart(){ drawer.classList.remove("open"); drawer.setAttribute("aria-hidden","true"); }
function escapeHtml(v){ return String(v??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c])); }

async function loadData() {
  await signInAnonymously(auth);
  const settingsSnap = await getDoc(doc(db,"v2_settings","reservation"));
  state.settings = settingsSnap.exists() ? {...defaultSettings,...settingsSnap.data()} : defaultSettings;
  const itemSnap = await getDocs(query(collection(db,"v2_public_items"),where("active","==",true)));
  state.items = itemSnap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(a.name).localeCompare(String(b.name),"ko"));
  updateSettingsUI(); renderItems(); renderCart();
  document.querySelector(".status-dot").classList.add("online"); el("syncText").textContent="재고 연결 완료";
}
function updateSettingsUI() {
  const cfg=state.settings;
  if(cfg.notice){ el("noticeBox").hidden=false; el("noticeBox").textContent=cfg.notice; }
  if(!cfg.enabled){ el("noticeBox").hidden=false; el("noticeBox").textContent=cfg.notice||"현재 예약 접수가 중지되었습니다."; }
  const today=new Date(); const min=today.toISOString().slice(0,10); const maxDate=new Date(today); maxDate.setDate(maxDate.getDate()+Number(cfg.daysAhead||14));
  el("dateInput").min=min; el("dateInput").max=maxDate.toISOString().slice(0,10); el("dateInput").value=min;
  const options=(cfg.times||[]).filter(x=>x.active!==false).map(x=>`<option value="${x.time}">${x.time}</option>`).join("");
  el("timeInput").innerHTML=`<option value="">시간 선택</option>${options}`;
}
function validateSchedule(dateText,timeText){
  const cfg=state.settings; const target=new Date(`${dateText}T${timeText}:00`); const now=new Date();
  if(!cfg.enabled) throw new Error("현재 예약 접수가 중지되었습니다.");
  const weekday=(target.getDay()+6)%7;
  if(!(cfg.weekdays||[]).map(Number).includes(weekday)) throw new Error("예약 가능한 요일이 아닙니다.");
  if((target-now)/36e5 < Number(cfg.cutoffHours||0)) throw new Error(`예약은 수령 ${cfg.cutoffHours||0}시간 전까지 가능합니다.`);
  return target;
}
async function createReservation(event){
  event.preventDefault();
  const brand=el("brandInput").value.trim(), bookingDate=el("dateInput").value, bookingTime=el("timeInput").value;
  if(brand.length<2) return toast("브랜드명을 2자 이상 입력하세요.");
  if(!bookingDate||!bookingTime) return toast("수령 날짜와 시간을 선택하세요.");
  if(!state.cart.size) return toast("예약 품목을 담아주세요.");
  try{
    const target=validateSchedule(bookingDate,bookingTime);
    const no=`R${bookingDate.replaceAll('-','').slice(2)}-${crypto.randomUUID().slice(0,6).toUpperCase()}`;
    const reservationRef=doc(db,"v2_reservations",no);
    const slotRef=doc(db,"v2_slot_usage",`${bookingDate}_${bookingTime.replace(':','')}`);
    await runTransaction(db,async tx=>{
      const slotSnap=await tx.get(slotRef); const used=slotSnap.exists()?Number(slotSnap.data().count||0):0;
      const timeCfg=(state.settings.times||[]).find(x=>x.time===bookingTime); const capacity=Number(timeCfg?.capacity||3);
      if(used>=capacity) throw new Error("선택한 시간의 예약이 마감되었습니다.");
      const reservationItems=[];
      for(const [id,row] of state.cart){
        const ref=doc(db,"v2_public_items",id), snap=await tx.get(ref);
        if(!snap.exists()) throw new Error(`${row.item.name} 품목이 없습니다.`);
        const live={id,...snap.data()}, available=availableQty(live), max=Number(live.reservationMaxQty||available);
        if(!live.active||!live.reservable) throw new Error(`${live.name}은 예약할 수 없습니다.`);
        if(row.qty>available||row.qty>max) throw new Error(`${live.name}의 예약 가능수량이 변경되었습니다.`);
        tx.update(ref,{reservedQty:Number(live.reservedQty||0)+row.qty,updatedAt:serverTimestamp()});
        reservationItems.push({itemId:id,itemName:live.name,qty:row.qty,displayQty:formatQty(row.qty,live),unit:live.unit||"개"});
      }
      tx.set(slotRef,{bookingDate,bookingTime,count:used+1,capacity,updatedAt:serverTimestamp()},{merge:true});
      tx.set(reservationRef,{reservationNo:no,brand,bookingDate,bookingTime,bookingAt:Timestamp.fromDate(target),items:reservationItems,status:"예약",createdAt:serverTimestamp(),uid:auth.currentUser.uid});
    });
    state.cart.clear(); renderCart(); closeCart(); el("reservationNumber").textContent=no; el("successDialog").showModal();
    await loadData();
  }catch(error){ console.error(error); toast(error.message||"예약 처리 중 오류가 발생했습니다."); }
}

el("searchInput").addEventListener("input",e=>{state.search=e.target.value;renderItems();});
document.querySelectorAll(".filter").forEach(btn=>btn.onclick=()=>{document.querySelectorAll(".filter").forEach(x=>x.classList.remove("active"));btn.classList.add("active");state.filter=btn.dataset.filter;renderItems();});
el("openCart").onclick=openCart; document.querySelectorAll("[data-close-cart]").forEach(x=>x.onclick=closeCart);
el("reservationForm").addEventListener("submit",createReservation);
el("closeSuccess").onclick=()=>el("successDialog").close();
el("copyReservation").onclick=async()=>{await navigator.clipboard.writeText(el("reservationNumber").textContent);toast("예약번호를 복사했습니다.");};
loadData().catch(error=>{console.error(error);el("syncText").textContent="연결 실패";toast("Firebase 연결 또는 권한 설정을 확인하세요.");});
