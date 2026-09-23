const { badRequest, notFound } = require('./errors');
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

// 有效账单：只有已出账的账单才锁住运单，已作废的不算
function isActiveBill(bill) {
  return Boolean(bill) && bill.status !== '已作废';
}

// 运单还被哪些有效账单占着：以账单的 waybillIds 归属为准，再兼容运单上的 billId 指向
// （历史上可能出现两张账单抢同一批运单，作废其中一张时只要另一张还在，运单就仍然锁着）
function lockingBillsOf(data, waybill) {
  const owners = data.bills.filter((bill) => isActiveBill(bill) && (bill.waybillIds || []).indexOf(waybill.id) >= 0);
  if (waybill.billId) {
    const direct = data.bills.find((bill) => bill.id === waybill.billId);
    if (isActiveBill(direct)) {
      const rest = owners.filter((bill) => bill.id !== direct.id);
      return [direct].concat(rest);
    }
  }
  return owners;
}

function lockingBillOf(data, waybill) {
  return lockingBillsOf(data, waybill)[0] || null;
}

function candidateWaybills(data, period, customerId) {
  return data.waybills.filter((waybill) => waybill.customerId === customerId && periodOf(waybill) === period);
}

// 把同一客户同一账期的候选运单拆成「可出账」与「已入账」两组
function splitCandidates(data, period, customerId) {
  const available = [];
  const locked = [];
  candidateWaybills(data, period, customerId).forEach((waybill) => {
    const owners = lockingBillsOf(data, waybill);
    if (owners.length) locked.push({ waybill, bill: owners[0], owners });
    else available.push(waybill);
  });
  return { available, locked };
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
  const unlockedIds = Array.isArray(bill.unlockedWaybillIds) ? bill.unlockedWaybillIds : [];
  const unlockedWaybills = unlockedIds
    .map((id) => data.waybills.find((waybill) => waybill.id === id))
    .filter(Boolean)
    .map((waybill) => ({
      id: waybill.id,
      code: waybill.code,
      toCity: waybill.toCity,
      createdAt: waybill.createdAt,
      billId: waybill.billId || null,
    }));
  return Object.assign({}, bill, {
    customerName: customer ? customer.name : '（客户已删）',
    customerCode: customer ? customer.code : '',
    lineSumYuan: pricing.roundFen(lineSum),
    amountText: Number(bill.amountYuan || 0).toFixed(2),
    lineSumText: pricing.roundFen(lineSum).toFixed(2),
    waybillCount: (bill.waybillIds || []).length,
    unlockedCount: unlockedIds.length,
    unlockedWaybills,
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
    })),
    unlockedWaybillIds: unlockedIds,
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

function parseTarget(data, payload) {
  const period = String((payload && payload.period) || '').trim();
  const customerId = String((payload && payload.customerId) || '').trim();
  if (!/^[0-9]{4}-[0-9]{2}$/.test(period)) throw badRequest('BILL_PERIOD_INVALID', '账期要形如 2026-09', { field: 'period' });
  const customer = findCustomer(data, customerId);
  if (!customer) throw badRequest('BILL_CUSTOMER_REQUIRED', '要选一个客户', { field: 'customerId' });
  return { period, customerId, customer };
}

function briefWaybill(waybill) {
  return {
    id: waybill.id,
    code: waybill.code,
    toCity: waybill.toCity,
    createdAt: waybill.createdAt,
  };
}

// 出账前检查：列出这个账期这个客户哪些运单可以出账、哪些已经被哪张账单锁住
function previewBill(payload) {
  const data = load();
  const { period, customer } = parseTarget(data, payload);
  const split = splitCandidates(data, period, customer.id);
  if (candidateWaybills(data, period, customer.id).length === 0) {
    throw badRequest('BILL_NO_WAYBILL', '这个账期里这个客户名下没有运单', { field: 'period' });
  }
  return {
    period,
    customerId: customer.id,
    customerName: customer.name,
    customerCode: customer.code,
    availableCount: split.available.length,
    lockedCount: split.locked.length,
    available: split.available.map(briefWaybill),
    locked: split.locked.map(({ waybill, bill }) => Object.assign(briefWaybill(waybill), {
      billId: bill.id,
      billCode: bill.code,
      billStatus: bill.status,
    })),
  };
}

function generateBill(payload) {
  const data = load();
  const { period, customer } = parseTarget(data, payload);
  const split = splitCandidates(data, period, customer.id);
  if (candidateWaybills(data, period, customer.id).length === 0) {
    throw badRequest('BILL_NO_WAYBILL', '这个账期里这个客户名下没有运单', { field: 'period' });
  }
  if (split.available.length === 0) {
    const billCodes = Array.from(new Set(split.locked.map((item) => item.bill.code)));
    const scope = billCodes.length === 1
      ? '这批运单已经全部入账（账单 ' + billCodes[0] + '）'
      : '这批运单已经全部入账，涉及 ' + billCodes.length + ' 张账单：' + billCodes.join('、');
    throw badRequest('BILL_WAYBILLS_LOCKED', scope + '，先作废原账单才能重新出账', {
      field: 'period',
      locked: split.locked.map(({ waybill, bill }) => ({
        waybillId: waybill.id,
        code: waybill.code,
        billId: bill.id,
        billCode: bill.code,
      })),
    });
  }
  const targets = split.available;
  const priced = priceBill(data, customer, targets);
  const samePeriod = data.bills.filter((bill) => bill.period === period && bill.customerId === customer.id).length;
  const bill = {
    id: nextId('bill', data.bills),
    code: 'ZD' + period.replace('-', '') + '-' + customer.code + String(samePeriod + 1).padStart(2, '0'),
    period,
    customerId: customer.id,
    status: '已出账',
    createdAt: new Date().toISOString(),
    waybillIds: targets.map((waybill) => waybill.id),
    lines: priced.lines,
    amountYuan: priced.amountYuan,
    discountPermille: priced.permille,
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
  bill.status = '已作废';
  bill.voidedAt = new Date().toISOString();
  // 作废即解锁：把账单名下、且没有被其他有效账单占用的运单松开，并记下解锁了哪几条
  const unlocked = [];
  const stillLocked = [];
  (bill.waybillIds || []).forEach((waybillId) => {
    const waybill = data.waybills.find((item) => item.id === waybillId);
    if (!waybill) return;
    const otherOwners = data.bills.filter((item) => item.id !== bill.id && isActiveBill(item)
      && (item.waybillIds || []).indexOf(waybillId) >= 0);
    if (otherOwners.length > 0) {
      // 历史重复账单：另一张有效账单还占着这条运单，保持锁定，指针留给那张账单
      if (waybill.billId === bill.id) waybill.billId = otherOwners[0].id;
      stillLocked.push(Object.assign(briefWaybill(waybill), { billCode: otherOwners[0].code }));
      return;
    }
    waybill.billId = null;
    unlocked.push(briefWaybill(waybill));
  });
  bill.unlockedWaybillIds = unlocked.map((item) => item.id);
  save(data);
  return Object.assign(summarizeBill(bill, load()), { unlockedWaybills: unlocked, stillLockedWaybills: stillLocked });
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
  previewBill,
  generateBill,
  voidBill,
  listPeriods,
  periodOf,
  zoneOf,
  lockingBillOf,
};
