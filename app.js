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

const state = { items: [], settings: null, cart: new Map(), filter: "all", search: "", category: "전체" };
const el = id => document.getElementById(id);
const itemGrid = el("itemGrid"), emptyState = el("emptyState"), drawer = el("cartDrawer");

const defaultSettings = {
  enabled: true, notice: "", weekdays: [0,1,2,3,4], daysAhead: 14,
  applicationStartTime: "10:00", applicationEndTime: "11:30", pickupDayOffset: 1,
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
  return Math.max(0, Number(item.stock || 0) - Number(item.reservedQty || 0) - Number(item.reservationMinStock || 0));
}
function reservable(item) {
  return Boolean(item.active) && Boolean(item.reservable) && availableQty(item) > 0;
}
function normalizedCategory(item){ return String(item.category || "기타").trim() || "기타"; }
function renderCategories(){
  const counts=new Map(); state.items.forEach(item=>{const c=normalizedCategory(item);counts.set(c,(counts.get(c)||0)+1);});
  const categories=[...counts.keys()].sort((a,b)=>a==="기타"?1:b==="기타"?-1:a.localeCompare(b,"ko"));
  const list=["전체",...categories]; if(!list.includes(state.category)) state.category="전체";
  el("categoryTabs").innerHTML=list.map(c=>`<button type="button" class="category-tab ${state.category===c?'active':''}" data-category="${escapeHtml(c)}">${escapeHtml(c)}<span class="category-count">${c==="전체"?state.items.length:counts.get(c)}</span></button>`).join("");
  document.querySelectorAll("[data-category]").forEach(b=>b.onclick=()=>{state.category=b.dataset.category;renderCategories();renderItems();});
}
function renderItems() {
  const term = state.search.toLowerCase();
  const list = state.items.filter(item => {
    const match = !term || String(item.name || "").toLowerCase().includes(term) || normalizedCategory(item).toLowerCase().includes(term);
    const categoryMatch = state.category === "전체" || normalizedCategory(item) === state.category;
    const filter = state.filter === "all" ||
      (state.filter === "reservable" && reservable(item)) ||
      (state.filter === "available" && Number(item.stock || 0) > 0);
    return match && categoryMatch && filter;
  });
  el("resultCount").textContent = `${list.length}개 품목`;
  emptyState.hidden = list.length > 0;
  itemGrid.innerHTML = list.map(item => {
    const stock = Number(item.stock || 0), available = availableQty(item);
    const clickable = reservable(item);
    return `<article class="item-card ${clickable?'item-card-clickable':''}" data-item-card="${item.id}" role="${clickable?'button':'article'}" tabindex="${clickable?'0':'-1'}">
      <span class="item-category">${escapeHtml(normalizedCategory(item))}</span>
      <div class="item-card-top"><h4>${escapeHtml(item.name)}</h4><span class="stock-badge ${stock<=0?'soldout':''}">${stock<=0?'품절':'재고 있음'}</span></div>
      <div class="item-meta"><div>현재고<strong>${escapeHtml(formatQty(stock,item))}</strong><small>낱개환산 ${stock.toLocaleString()}${escapeHtml(item.unit||'개')}</small></div><div>예약가능<strong>${item.reservable?escapeHtml(formatQty(available,item)):'-'}</strong><small>${item.reservable?`낱개환산 ${available.toLocaleString()}${escapeHtml(item.unit||'개')}`:''}</small></div></div>
      <div class="item-card-footer"><div class="availability">${item.reservable ? `1회 상한 ${item.reservationMaxQty ? formatQty(Number(item.reservationMaxQty),item) : '예약가능수량'} · ${item.reservationUnit||'박스+낱개'}` : '이 품목은 예약 대상이 아닙니다.'}</div>
      <div class="card-open-hint">${clickable?'품목 카드를 눌러 수량 선택':'예약할 수 없는 품목'}</div></div>
    </article>`;
  }).join("");
  document.querySelectorAll("[data-item-card]").forEach(card => {
    const open=()=>openItemCart(card.dataset.itemCard);
    card.addEventListener("click",open);
    card.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();open();}});
  });
}
function openItemCart(id) {
  const item = state.items.find(x => x.id === id);
  if (!item || !reservable(item)) return;
  if (!state.cart.has(id)) state.cart.set(id, { item, qty: 0 });
  renderCart();
  openCart();
}

function changeQty(id, delta, mode="unit") {
  const row = state.cart.get(id); if (!row) return;
  const step = mode === "box" ? Math.max(1,Number(row.item.packQty||1)) : 1;
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
    <div class="cart-quantity-actions">
      ${(item.reservationUnit||"박스+낱개")!=="낱개만" && Number(item.packQty||1)>1 ? `<div class="qty-control"><button type="button" data-box-minus="${item.id}">−</button><strong>${escapeHtml(item.packUnit||'박스')}</strong><button type="button" data-box-plus="${item.id}">+</button></div>` : ''}
      ${(item.reservationUnit||"박스+낱개")!=="박스만" ? `<div class="qty-control"><button type="button" data-unit-minus="${item.id}">−</button><strong>${escapeHtml(item.unit||'개')}</strong><button type="button" data-unit-plus="${item.id}">+</button></div>` : ''}
    </div>
  </div>`).join("") : `<div class="cart-empty">예약할 품목을 담아주세요.</div>`;
  document.querySelectorAll("[data-box-minus]").forEach(b=>b.onclick=()=>changeQty(b.dataset.boxMinus,-1,"box"));
  document.querySelectorAll("[data-box-plus]").forEach(b=>b.onclick=()=>changeQty(b.dataset.boxPlus,1,"box"));
  document.querySelectorAll("[data-unit-minus]").forEach(b=>b.onclick=()=>changeQty(b.dataset.unitMinus,-1,"unit"));
  document.querySelectorAll("[data-unit-plus]").forEach(b=>b.onclick=()=>changeQty(b.dataset.unitPlus,1,"unit"));
  document.querySelectorAll("[data-remove]").forEach(b=>b.onclick=()=>{state.cart.delete(b.dataset.remove);renderCart();});
  el("submitReservation").disabled = !rows.some(x=>x.qty>0) || !state.settings?.enabled;
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
  updateSettingsUI(); renderCategories(); renderItems(); renderCart();
  document.querySelector(".status-dot").classList.add("online"); el("syncText").textContent="재고 연결 완료";
}
function updateSettingsUI() {
  const cfg=state.settings;
  if(cfg.notice){ el("noticeBox").hidden=false; el("noticeBox").textContent=cfg.notice; }
  if(!cfg.enabled){ el("noticeBox").hidden=false; el("noticeBox").textContent=cfg.notice||"현재 예약 접수가 중지되었습니다."; }
  const pickupDate=new Date();
  pickupDate.setDate(pickupDate.getDate()+Number(cfg.pickupDayOffset ?? 1));
  const pickupDateText=pickupDate.toISOString().slice(0,10);
  el("dateInput").min=pickupDateText;
  el("dateInput").max=pickupDateText;
  el("dateInput").value=pickupDateText;
  const options=(cfg.times||[]).filter(x=>x.active!==false).map(x=>`<option value="${x.time}">${x.time}</option>`).join("");
  el("timeInput").innerHTML=`<option value="">시간 선택</option>${options}`;
}
function validateSchedule(dateText,timeText){
  const cfg=state.settings; const target=new Date(`${dateText}T${timeText}:00`); const now=new Date();
  if(!cfg.enabled) throw new Error("현재 예약 접수가 중지되었습니다.");
  const weekday=(now.getDay()+6)%7;
  if(!(cfg.weekdays||[]).map(Number).includes(weekday)) throw new Error("오늘은 모바일 예약 신청 가능 요일이 아닙니다.");
  const currentTime=`${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
  const open=cfg.applicationStartTime||"10:00";
  const close=cfg.applicationEndTime||"11:30";
  if(currentTime<open || currentTime>close) throw new Error(`모바일 예약은 ${open}~${close}에 신청할 수 있습니다.`);
  const expected=new Date(); expected.setDate(expected.getDate()+Number(cfg.pickupDayOffset ?? 1));
  if(dateText!==expected.toISOString().slice(0,10)) throw new Error("설정된 수령일과 다릅니다. 화면을 새로고침해주세요.");
  return target;
}
async function createReservation(event){
  event.preventDefault();
  const brand=el("brandInput").value.trim(), bookingDate=el("dateInput").value, bookingTime=el("timeInput").value;
  if(brand.length<2) return toast("브랜드명을 2자 이상 입력하세요.");
  if(!bookingDate||!bookingTime) return toast("수령 날짜와 시간을 선택하세요.");
  if(![...state.cart.values()].some(row=>row.qty>0)) return toast("예약 수량을 선택해주세요.");
  for(const [id,row] of [...state.cart.entries()]) if(row.qty<=0) state.cart.delete(id);
  try{
    const target=validateSchedule(bookingDate,bookingTime);
    const createdNow = new Date();
    const datePart = `${createdNow.getFullYear()}${String(createdNow.getMonth()+1).padStart(2,"0")}${String(createdNow.getDate()).padStart(2,"0")}`;
    const timePart = `${String(createdNow.getHours()).padStart(2,"0")}${String(createdNow.getMinutes()).padStart(2,"0")}${String(createdNow.getSeconds()).padStart(2,"0")}`;
    const milliPart = String(createdNow.getMilliseconds()).padStart(3,"0");
    const no = `예약-${datePart}-${timePart}-${milliPart}`;
    const reservationRef=doc(db,"v2_reservations",no);
    const slotRef=doc(db,"v2_slot_usage",`${bookingDate}_${bookingTime.replace(':','')}`);
    await runTransaction(db, async tx => {
      const slotSnap = await tx.get(slotRef);
      const cartRows = [...state.cart.entries()].map(([id, row]) => ({ id, row, ref: doc(db, "v2_public_items", id) }));
      const itemSnaps = [];
      for (const cartRow of cartRows) itemSnaps.push(await tx.get(cartRow.ref));

      const used = slotSnap.exists() ? Number(slotSnap.data().count || 0) : 0;
      const timeCfg = (state.settings.times || []).find(x => x.time === bookingTime);
      const capacity = Number(timeCfg?.capacity || 3);
      if (used >= capacity) throw new Error("선택한 시간의 예약이 마감되었습니다.");

      const reservationItems = [];
      const itemUpdates = [];
      cartRows.forEach((cartRow, index) => {
        const snap = itemSnaps[index];
        if (!snap.exists()) throw new Error(`${cartRow.row.item.name} 품목이 없습니다.`);
        const live = { id: cartRow.id, ...snap.data() };
        const available = availableQty(live);
        const max = Number(live.reservationMaxQty || available);
        if (!live.active || !live.reservable) throw new Error(`${live.name}은 예약할 수 없습니다.`);
        if (cartRow.row.qty > available || cartRow.row.qty > max) throw new Error(`${live.name}의 예약 가능수량이 변경되었습니다.`);
        itemUpdates.push({ ref: cartRow.ref, data: { reservedQty: Number(live.reservedQty || 0) + cartRow.row.qty, updatedAt: serverTimestamp() } });
        reservationItems.push({ itemId: cartRow.id, itemName: live.name, qty: cartRow.row.qty, displayQty: formatQty(cartRow.row.qty, live), unit: live.unit || "개" });
      });

      itemUpdates.forEach(update => tx.update(update.ref, update.data));
      tx.set(slotRef,{bookingDate,bookingTime,count:used+1,capacity,updatedAt:serverTimestamp()},{merge:true});
      tx.set(reservationRef,{reservationNo:no,brand,bookingDate,bookingTime,bookingAt:Timestamp.fromDate(target),items:reservationItems,status:"예약",createdAt:serverTimestamp(),uid:auth.currentUser.uid});
    });
    state.cart.clear(); renderCart(); closeCart(); el("reservationNumber").textContent=no; el("successDialog").showModal();
    await loadData();
  }catch(error){ console.error(error); toast(error.message||"예약 처리 중 오류가 발생했습니다."); }
}

function setupWebGuidePopup(){
  const guide=document.querySelector(".service-guide");
  if(!guide || document.getElementById("webGuideDialog")) return;
  const originalHead=guide.querySelector(".service-guide-head");
  const originalGrid=guide.querySelector(".service-guide-grid");
  if(!originalGrid) return;

  const dialog=document.createElement("dialog");
  dialog.id="webGuideDialog";
  dialog.className="web-guide-dialog";
  dialog.innerHTML=`<div class="web-guide-dialog-head"><div><span class="web-guide-kicker">CONSUMABLES GUIDE</span><h2>소모품 수령 안내</h2></div><button type="button" class="icon-button" data-close-web-guide aria-label="닫기">×</button></div><div class="web-guide-dialog-body"></div><div class="web-guide-dialog-actions"><a href="tel:0221426026" class="web-guide-phone">☎ 내선 6026</a><button type="button" class="primary-button" data-close-web-guide>확인</button></div>`;
  dialog.querySelector(".web-guide-dialog-body").appendChild(originalGrid);
  document.body.appendChild(dialog);
  dialog.querySelectorAll("[data-close-web-guide]").forEach(button=>button.onclick=()=>dialog.close());
  dialog.addEventListener("click",event=>{if(event.target===dialog) dialog.close();});

  guide.innerHTML=`<div class="web-guide-summary"><div><span class="web-guide-kicker">CONSUMABLES GUIDE</span><strong>소모품 수령 안내</strong><small>운영시간, 예약 및 수령시간을 확인하세요.</small></div><div class="web-guide-summary-actions"><a href="tel:0221426026" class="web-guide-phone" aria-label="02-2142-6026 전화걸기">☎ 내선 6026</a><button type="button" id="openWebGuide" class="web-guide-open">안내 보기</button></div></div>`;
  document.getElementById("openWebGuide").onclick=()=>dialog.showModal();
}

setupWebGuidePopup();
el("searchInput").addEventListener("input",e=>{state.search=e.target.value;renderItems();});
document.querySelectorAll(".filter").forEach(btn=>btn.onclick=()=>{document.querySelectorAll(".filter").forEach(x=>x.classList.remove("active"));btn.classList.add("active");state.filter=btn.dataset.filter;renderItems();});
el("openCart").onclick=openCart; document.querySelectorAll("[data-close-cart]").forEach(x=>x.onclick=closeCart);
const continueShopping=el("continueShopping"); if(continueShopping) continueShopping.onclick=closeCart;
el("reservationForm").addEventListener("submit",createReservation);
el("closeSuccess").onclick=()=>el("successDialog").close();
el("copyReservation").onclick=async()=>{await navigator.clipboard.writeText(el("reservationNumber").textContent);toast("예약번호를 복사했습니다.");};
loadData().catch(error=>{console.error(error);el("syncText").textContent="연결 실패";toast("Firebase 연결 또는 권한 설정을 확인하세요.");});
