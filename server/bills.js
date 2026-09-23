const { badRequest, conflict, notFound } = require('./errors');
const { load, save, nextId } = require('./store');
const pricing = require('./pricing');
const { findCustomer } = require('./customers');

function cleanCity(value) {
  return String(value == null ? '' : value).trim();
}

// 账单里的分区判断：拿收件城市跟各分区登记的城市直接比
function zoneOf(data, city) {
  const target = cleanCity(city);
  const matched = data.zones.find((zone) => (zone.cities || []).some((item) => cleanCity(item) === target));
  return matched || data.zones[0] || null;
}

// 账期：按运单创建时刻的年月
function periodOf(waybill) {
  const date = new Date(String(waybill.createdAt || ''));
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 7);
}

function candidateWaybills(data, period, customerId) {
  return data.waybills.filter((waybill) => waybill.customerId === customerId && periodOf(waybill) === period);
}

// 只有「已出账」的账单还占着运单；已作废的账单不再锁任何东西
function activeBills(data) {
  return data.bills.filter((bill) => bill.status === '已出账');
}

// 运单被哪张已出账账单占用。优先信运单上的 billId（出账时同步写入），
// 对账单明细里有、运单标记缺失的历史数据也兜得住
function activeBillForWaybill(data, waybill) {
  if (waybill.billId) {
    const direct = data.bills.find((bill) => bill.id === waybill.billId && bill.status === '已出账');
    if (direct) return direct;
  }
  return activeBills(data).find((bill) => bill.waybillIds.includes(waybill.id)) || null;
}

function waybillBrief(waybill) {
  return {
    id: waybill.id,
    code: waybill.code,
    toCity: waybill.toCity,
    weightKg: Number(waybill.weightKg),
    createdAt: waybill.createdAt,
  };
}

// 出账前检查：把这批候选运单拆成「可以出账」和「已经入账」两组，
// 已入账的标明被哪张账单占着，由前端列出来、由出账接口挡住
function preflightBilling(payload) {
  const data = load();
  const period = String((payload && payload.period) || '').trim();
  const customerId = String((payload && payload.customerId) || '').trim();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(period)) throw badRequest('BILL_PERIOD_INVALID', '账期要形如 2026-09', { field: 'period' });
  const customer = findCustomer(data, customerId);
  if (!customer) throw badRequest('BILL_CUSTOMER_REQUIRED', '要选一个客户', { field: 'customerId' });
  return buildPreflight(data, period, customer);
}

function buildPreflight(data, period, customer) {
  const candidates = candidateWaybills(data, period, customer.id);
  const available = [];
  const alreadyBilled = [];
  candidates.forEach((waybill) => {
    const bill = activeBillForWaybill(data, waybill);
    if (bill) {
      alreadyBilled.push(Object.assign(waybillBrief(waybill), {
        billId: bill.id,
        billCode: bill.code,
        billStatus: bill.status,
        billPeriod: bill.period,
      }));
    } else {
      available.push(waybillBrief(waybill));
    }
  });
  return {
    period,
    customerId: customer.id,
    customerName: customer.name,
    customerCode: customer.code,
    total: candidates.length,
    availableCount: available.length,
    alreadyBilledCount: alreadyBilled.length,
    available,
    alreadyBilled,
  };
}

// 出账计费：同一账期同一客户的运单合起来算一次首重续重，再按各自的计费重量分摊
function priceBill(data, customer, waybills) {
  const settings = pricing.settingsOf(data);
  const permille = pricing.discountPermilleOf(customer);
  if (waybills.length === 0) return { lines: [], amountYuan: 0, permille };
  const zone = zoneOf(data, waybills[0].toCity);
  const weights = waybills.map((waybill) => pricing.billableWeightKg(waybill, settings));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  const freightAll = pricing.freightYuan(zone, totalWeight, settings);
  const surchargeAll = waybills.reduce((sum, waybill, index) => (
    sum + pricing.surchargeYuan(zone, waybill, weights[index], settings)
  ), 0);
  const grossAll = freightAll + surchargeAll;
  const amountYuan = grossAll * permille / 1000;
  const lines = waybills.map((waybill, index) => {
    const weight = weights[index];
    const share = totalWeight > 0 ? weight / totalWeight : 0;
    const raw = (freightAll * share + pricing.surchargeYuan(zone, waybill, weight, settings)) * permille / 1000;
    const cached = Number(waybill.quoteCacheYuan);
    const amount = cached > 0 ? cached : pricing.roundFen(raw);
    return {
      waybillId: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      zoneName: zone ? zone.name : '',
      billableKg: weight,
      amountYuan: amount,
      fromCache: cached > 0,
    };
  });
  return { lines, amountYuan, permille };
}

function summarizeBill(bill, data) {
  const customer = findCustomer(data, bill.customerId);
  const lines = Array.isArray(bill.lines) ? bill.lines : [];
  const lineSum = lines.reduce((sum, line) => sum + Number(line.amountYuan || 0), 0);
  const waybills = (bill.waybillIds || [])
    .map((id) => data.waybills.find((waybill) => waybill.id === id))
    .filter(Boolean);
  const releasedIds = Array.isArray(bill.releasedWaybillIds) ? bill.releasedWaybillIds : [];
  return Object.assign({}, bill, {
    customerName: customer ? customer.name : '（客户已删）',
    customerCode: customer ? customer.code : '',
    lineSumYuan: pricing.roundFen(lineSum),
    amountText: Number(bill.amountYuan || 0).toFixed(2),
    lineSumText: pricing.roundFen(lineSum).toFixed(2),
    waybillCount: (bill.waybillIds || []).length,
    releasedCount: releasedIds.length,
    releasedWaybillIds: releasedIds,
    lines: lines.map((line) => Object.assign({}, line, {
      amountText: Number(line.amountYuan || 0).toFixed(2),
      billableText: Number(line.billableKg).toFixed(2) + ' kg',
    })),
    waybills: waybills.map((waybill) => ({
      id: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      weightKg: Number(waybill.weightKg),
      createdAt: waybill.createdAt,
      quoteCacheYuan: waybill.quoteCacheYuan,
      // 作废后运单已解锁：这里告诉前端每条运单现在还锁不锁
      stillLocked: Boolean(activeBillForWaybill(data, waybill)),
    })),
  });
}

function listBills(query) {
  const data = load();
  const customerId = String((query && query.customerId) || '').trim();
  const status = String((query && query.status) || '').trim();
  let bills = data.bills.map((bill) => summarizeBill(bill, data));
  if (customerId) bills = bills.filter((bill) => bill.customerId === customerId);
  if (status) bills = bills.filter((bill) => bill.status === status);
  bills.sort((a, b) => String(b.period).localeCompare(String(a.period)) || String(b.code).localeCompare(String(a.code)));
  return {
    bills,
    total: bills.length,
    issued: bills.filter((bill) => bill.status === '已出账').length,
    voided: bills.filter((bill) => bill.status === '已作废').length,
  };
}

function findBill(data, id) {
  return data.bills.find((bill) => bill.id === id) || null;
}

function getBill(id) {
  const data = load();
  const bill = findBill(data, id);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在');
  return summarizeBill(bill, data);
}

function generateBill(payload) {
  const data = load();
  const period = String((payload && payload.period) || '').trim();
  const customerId = String((payload && payload.customerId) || '').trim();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(period)) throw badRequest('BILL_PERIOD_INVALID', '账期要形如 2026-09', { field: 'period' });
  const customer = findCustomer(data, customerId);
  if (!customer) throw badRequest('BILL_CUSTOMER_REQUIRED', '要选一个客户', { field: 'customerId' });
  const targets = candidateWaybills(data, period, customerId);
  if (targets.length === 0) throw badRequest('BILL_NO_WAYBILL', '这个账期里这个客户没有可以出账的运单', { field: 'period' });
  // 挡住重复出账：已在「已出账」账单里的运单不能再进第二张，先把原账单作废才会放开
  const alreadyBilled = [];
  const available = [];
  targets.forEach((waybill) => {
    const owner = activeBillForWaybill(data, waybill);
    if (owner) alreadyBilled.push({ waybill, bill: owner });
    else available.push(waybill);
  });
  if (alreadyBilled.length > 0) {
    const ownerBills = Array.from(new Set(alreadyBilled.map((item) => item.bill)));
    throw conflict('BILL_WAYBILLS_ALREADY_BILLED',
      '这批运单里有 ' + alreadyBilled.length + ' 条已经入账（' + ownerBills.map((bill) => bill.code).join('、') + '），先把原账单作废才能重新出账',
      {
        period,
        customerId,
        availableCount: available.length,
        alreadyBilledCount: alreadyBilled.length,
        blockingBills: ownerBills.map((bill) => ({ id: bill.id, code: bill.code, status: bill.status })),
        alreadyBilled: alreadyBilled.map((item) => Object.assign(waybillBrief(item.waybill), {
          billId: item.bill.id,
          billCode: item.bill.code,
        })),
      });
  }
  const priced = priceBill(data, customer, targets);
  const samePeriod = data.bills.filter((bill) => bill.period === period && bill.customerId === customerId).length;
  const bill = {
    id: nextId('bill', data.bills),
    code: 'ZD' + period.replace('-', '') + '-' + customer.code + String(samePeriod + 1).padStart(2, '0'),
    period,
    customerId,
    status: '已出账',
    createdAt: new Date().toISOString(),
    waybillIds: targets.map((waybill) => waybill.id),
    lines: priced.lines,
    amountYuan: priced.amountYuan,
    discountPermille: priced.permille,
    releasedWaybillIds: [],
  };
  data.bills.push(bill);
  targets.forEach((waybill) => {
    waybill.billId = bill.id;
  });
  save(data);
  return summarizeBill(bill, load());
}

function voidBill(id) {
  const data = load();
  const bill = findBill(data, id);
  if (!bill) throw notFound('BILL_NOT_FOUND', '账单不存在');
  if (bill.status === '已作废') throw badRequest('BILL_ALREADY_VOID', '这张账单已经作废了');
  // 解锁：账单名下运单只要不再被「其他已出账账单」占用就放开；
  // 同一批运单误入两张已出账账单时，先作废的那张不会虚报解锁
  const otherActive = activeBills(data).filter((item) => item.id !== bill.id);
  const heldByOthers = (waybillId) => otherActive.some((item) => item.waybillIds.includes(waybillId));
  const released = [];
  (bill.waybillIds || []).forEach((waybillId) => {
    const waybill = data.waybills.find((item) => item.id === waybillId);
    if (!waybill) return;
    if (waybill.billId === bill.id) waybill.billId = null;
    if (!heldByOthers(waybillId)) released.push(waybillBrief(waybill));
  });
  bill.status = '已作废';
  bill.voidedAt = new Date().toISOString();
  bill.releasedWaybillIds = released.map((item) => item.id);
  bill.releasedAt = bill.voidedAt;
  save(data);
  const summary = summarizeBill(bill, load());
  summary.releasedWaybills = released;
  return summary;
}

function listPeriods() {
  const data = load();
  const periods = new Set();
  data.waybills.forEach((waybill) => {
    const period = periodOf(waybill);
    if (period) periods.add(period);
  });
  data.bills.forEach((bill) => periods.add(bill.period));
  return { periods: Array.from(periods).sort() };
}

module.exports = {
  listBills,
  getBill,
  generateBill,
  voidBill,
  preflightBilling,
  listPeriods,
  periodOf,
  zoneOf,
  activeBillForWaybill,
};
