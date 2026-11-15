/* ==========================================================================
   대출 갈아타기 계산기 — app.js
   - 한국 은행 약정서와 같은 상환·중도상환수수료 계산
   - 지금 대출 / 갈아탈 대출 상환방식 개별 선택 (원리금균등·원금균등·만기일시·체증식)
   - 체증식: 1년마다 체증률만큼 오르는 계단식(정률) 모델, 원금 합계 = P · 만기 잔액 0원
   - 집값 대비 LTV 계산
   - 외부 라이브러리 없음 (SVG 차트 직접 그림)
   ========================================================================== */
(function () {
  'use strict';

  var MAN = 10000;
  var MAX_MONTHS = 600;
  var MAX_STEP = 10;
  var METHOD_NAME = {
    equal: '원리금균등',
    principal: '원금균등',
    bullet: '만기일시',
    graduated: '체증식'
  };
  var LTV_BASIS_LABEL = {
    '70': '일반 기준 70%',
    '40': '규제지역 기준 40%',
    '70e': '생애최초 기준 70%',
    '80e': '생애최초(지방) 기준 80%'
  };
  var JEONSE_LTV_LIMIT = 80;

  function $(id) { return document.getElementById(id); }
  function toNum(v) { var n = parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : 0; }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  /* ------------------------------------------------------------------ 수학 */

  /* 원리금균등 월 납입금 */
  function levelPayment(P, i, n) {
    if (n <= 0) return 0;
    if (Math.abs(i) < 1e-12) return P / n;
    return (P * i) / (1 - Math.pow(1 + i, -n));
  }

  /* 체증식 첫해 월 납입금
     연 g%씩 오르는 계단식: k년차 월 납입금 = A × (1+g)^(k-1)
     모든 납입액을 월금리로 할인한 합 = 원금 이 되도록 A를 역산한다. */
  function graduatedFirstPayment(P, i, n, gPct) {
    if (n <= 0) return 0;
    var g = clamp(gPct, 0, MAX_STEP) / 100;
    var disc = 1 / (1 + i);
    var pow = disc;            /* (1+i)^-m */
    var sum = 0;
    for (var m = 1; m <= n; m++) {
      if ((m - 1) % 12 === 0) sum += Math.pow(1 + g, (m - 1) / 12) * pow;
      else sum += Math.pow(1 + g, Math.floor((m - 1) / 12)) * pow;
      pow *= disc;
    }
    return P / sum;
  }

  /* 상환 스케줄: 월별 이자·원금·납입액 */
  function buildSchedule(P, n, annualPct, method, stepPct) {
    var i = annualPct / 100 / 12;
    var rows = [];
    var balance = P;
    var level = null, firstPay = null, g = 0;
    var m, interest, principal, payment;
    var negAmort = false;

    if (n <= 0 || P <= 0) {
      return emptyLoan(P, n, annualPct, method, stepPct);
    }

    if (method === 'bullet') {
      for (m = 1; m <= n; m++) {
        interest = balance * i;
        principal = (m === n) ? balance : 0;
        rows.push({ interest: interest, principal: principal, payment: interest + principal });
        balance -= principal;
        if (balance < 1e-6) balance = 0;
      }
    } else if (method === 'principal') {
      var base = P / n;
      for (m = 1; m <= n; m++) {
        interest = balance * i;
        principal = Math.min(balance, base);
        rows.push({ interest: interest, principal: principal, payment: interest + principal });
        balance -= principal;
        if (balance < 1e-6) balance = 0;
      }
    } else if (method === 'graduated') {
      g = clamp(stepPct || 0, 0, MAX_STEP) / 100;
      firstPay = graduatedFirstPayment(P, i, n, stepPct || 0);
      for (m = 1; m <= n; m++) {
        payment = firstPay * Math.pow(1 + g, Math.floor((m - 1) / 12));
        interest = balance * i;
        principal = payment - interest;
        if (principal < 0) negAmort = true;
        if (m === n || principal > balance) {
          principal = balance;
          payment = interest + principal;
        }
        rows.push({ interest: interest, principal: principal, payment: interest + principal });
        balance -= principal;
        if (Math.abs(balance) < 1e-6) balance = 0;
      }
    } else {
      level = levelPayment(P, i, n);
      for (m = 1; m <= n; m++) {
        interest = balance * i;
        principal = level - interest;
        if (m === n || principal > balance) principal = balance;
        rows.push({ interest: interest, principal: principal, payment: interest + principal });
        balance -= principal;
        if (balance < 1e-6) balance = 0;
      }
    }

    var totalInterest = 0, totalPayment = 0;
    for (var k = 0; k < rows.length; k++) {
      totalInterest += rows[k].interest;
      totalPayment += rows[k].payment;
    }

    /* 연 단위 요약: 해마다 평균·첫달·마지막달 */
    var yearly = [];
    var y, from, to, s, cnt;
    for (y = 0; y * 12 < n; y++) {
      from = y * 12;
      to = Math.min(n, (y + 1) * 12);
      s = 0; cnt = 0;
      for (k = from; k < to; k++) { s += rows[k].payment; cnt++; }
      yearly.push({
        year: y + 1,
        avg: s / cnt,
        first: rows[from].payment,
        last: rows[to - 1].payment
      });
    }

    return {
      rows: rows,
      n: n,
      principal: P,
      rate: annualPct,
      method: method,
      stepRate: method === 'graduated' ? clamp(stepPct || 0, 0, MAX_STEP) : 0,
      totalInterest: totalInterest,
      totalPayment: totalPayment,
      totalRepay: P + totalInterest,
      avgPayment: totalPayment / n,
      firstPayment: rows.length ? rows[0].payment : 0,
      lastPayment: rows.length ? rows[rows.length - 1].payment : 0,
      levelPayment: level,
      firstYear: yearly.length ? yearly[0] : null,
      lastYear: yearly.length ? yearly[yearly.length - 1] : null,
      yearly: yearly,
      negAmort: negAmort,
      endBalance: balance
    };
  }

  function emptyLoan(P, n, annualPct, method, stepPct) {
    return {
      rows: [], n: n, principal: P, rate: annualPct, method: method,
      stepRate: method === 'graduated' ? (stepPct || 0) : 0,
      totalInterest: 0, totalPayment: 0, totalRepay: P, avgPayment: 0,
      firstPayment: 0, lastPayment: 0, levelPayment: null,
      firstYear: null, lastYear: null, yearly: [], negAmort: false, endBalance: P
    };
  }

  /* 갈아타기 손익 전체 계산 */
  function computeLoan(input) {
    var P = input.principal;
    var n = input.months;
    var current = buildSchedule(P, n, input.rateNow, input.methodNow, input.stepRate);
    var next = buildSchedule(P, n, input.rateNew, input.methodNew, input.stepRate);

    /* 중도상환수수료 = 상환원금 × 수수료율 × (잔존일수 ÷ 대출기간)
       대출기간이 3년을 넘으면 3년(1,095일)로 계산 → 개월 비율로 반영 */
    var basis = input.feeBasis > 0 ? input.feeBasis : 36;
    var ratio = Math.max(0, Math.min(1, input.feeMonths / basis));
    var fee = P * (input.feeRate / 100) * ratio;
    var upfront = fee + input.etcCost;

    var interestSaving = current.totalInterest - next.totalInterest;
    var net = interestSaving - upfront;

    var series = [{ m: 0, net: -upfront }];
    var c1 = 0, c2 = 0, breakeven = null;
    for (var m = 0; m < n; m++) {
      c1 += current.rows[m].interest;
      c2 += next.rows[m].interest;
      var v = (c1 - c2) - upfront;
      series.push({ m: m + 1, net: v });
      if (breakeven === null && v >= 0) breakeven = m + 1;
    }

    /* 월 납입 지표: 방식이 같으면 그 방식에 맞는 값, 다르면 월 평균으로 통일 */
    var sameMethod = input.methodNow === input.methodNew;
    var pick = function (loan) {
      if (!sameMethod) return { label: '월 평균 상환액', value: loan.avgPayment };
      if (loan.method === 'bullet') return { label: '월 이자', value: loan.firstPayment };
      if (loan.method === 'principal') return { label: '월 평균 상환액', value: loan.avgPayment };
      if (loan.method === 'graduated') return { label: '1년차 월 납입금', value: loan.firstYear ? loan.firstYear.avg : 0 };
      return { label: '월 납입액', value: loan.firstPayment };
    };

    /* LTV */
    var housePrice = input.housePrice;
    var isJeonse = input.loanType === 'jeonse';
    var ltvLimit = isJeonse ? JEONSE_LTV_LIMIT : parseFloat(input.ltvBasis) || 70;
    var ltv = housePrice > 0 ? (P / housePrice) * 100 : null;

    return {
      input: input,
      current: current,
      next: next,
      fee: fee,
      feeRatio: ratio,
      upfront: upfront,
      interestSaving: interestSaving,
      net: net,
      breakeven: breakeven,
      series: series,
      sameMethod: sameMethod,
      monthlyCurrent: pick(current),
      monthlyNext: pick(next),
      ltv: ltv,
      ltvLimit: ltvLimit,
      ltvMax: housePrice > 0 ? housePrice * ltvLimit / 100 : null,
      ltvGap: housePrice > 0 ? housePrice * ltvLimit / 100 - P : null,
      isJeonse: isJeonse
    };
  }

  /* ---------------------------------------------------------------- 포맷 */

  function fmtNum(n) {
    return Math.round(n).toLocaleString('ko-KR');
  }

  /* 원 → "1억 2,345만" / "7,142만" / "8,500" (만 단위로 줄임) */
  function splitAmount(abs) {
    var totalMan = Math.floor(abs / MAN);
    var rest = Math.round(abs - totalMan * MAN);
    if (rest >= MAN) { totalMan += 1; rest = 0; }
    return { totalMan: totalMan, rest: rest };
  }

  function fmtShort(n) {
    if (!isFinite(n)) return '—';
    var sign = n < -0.5 ? '−' : '';
    var abs = Math.abs(n);
    if (abs < MAN) return sign + fmtNum(abs);
    var s = splitAmount(abs);
    var eok = Math.floor(s.totalMan / 10000);
    var man = s.totalMan % 10000;
    if (eok) return sign + fmtNum(eok) + '억' + (man ? ' ' + fmtNum(man) + '만' : '');
    return sign + fmtNum(man) + '만';
  }

  /* 1억 미만이면 원 단위까지: "24만 6,332" (월 납입금처럼 정확도가 필요한 값) */
  function fmtPrecise(n) {
    if (!isFinite(n)) return '—';
    var abs = Math.abs(n);
    if (abs >= 100000000 || abs < MAN) return fmtShort(n);
    var s = splitAmount(abs);
    return (n < -0.5 ? '−' : '') + fmtNum(s.totalMan) + '만' + (s.rest ? ' ' + fmtNum(s.rest) : '');
  }

  function fmtKrw(n) { return fmtShort(n) + ' 원'; }
  function fmtWon(n) { return (n < -0.5 ? '−' : '') + fmtNum(Math.abs(n)) + '원'; }

  function fmtSigned(n) {
    var s = fmtShort(n);
    return n > 0.5 ? '+' + s : s;
  }

  function fmtSignedPrecise(n) {
    var s = fmtPrecise(n);
    return n > 0.5 ? '+' + s : s;
  }

  function fmtPct(v, digits) {
    if (v === null || !isFinite(v)) return '—';
    return v.toFixed(digits === undefined ? 1 : digits) + '%';
  }

  function termLabel(months) {
    var y = Math.floor(months / 12);
    var m = months % 12;
    if (y && m) return y + '년 ' + m + '개월';
    if (y) return y + '년';
    return m + '개월';
  }

  function methodLabel(method, stepRate) {
    if (method === 'graduated') return '체증식' + (stepRate ? ' 연 ' + stepRate + '%' : '');
    return METHOD_NAME[method] || method;
  }

  /* 받침에 따라 '로' / '으로' */
  function withRo(word) {
    var c = word.charCodeAt(word.length - 1);
    var jong = (c - 0xAC00) % 28;
    return word + (jong === 0 ? '로' : '으로');
  }

  /* ----------------------------------------------------------------- 상태 */

  var state = { months: 360, last: null };

  function radioValue(name) {
    var el = document.querySelector('input[name="' + name + '"]:checked');
    return el ? el.value : null;
  }

  function readInput() {
    var loanType = radioValue('loanType') || 'mortgage';
    return {
      loanType: loanType,
      methodNow: radioValue('methodNow') || 'equal',
      methodNew: radioValue('methodNew') || 'equal',
      stepRate: clamp(toNum($('stepRate').value), 0, MAX_STEP),
      principal: Math.max(0, toNum($('principal').value) * MAN),
      housePrice: Math.max(0, toNum($('housePrice').value) * MAN),
      ltvBasis: $('ltvBasis').value,
      months: state.months,
      rateNow: Math.max(0, toNum($('rateNow').value)),
      rateNew: Math.max(0, toNum($('rateNew').value)),
      feeRate: Math.max(0, toNum($('feeRate').value)),
      feeMonths: Math.max(0, toNum($('feeMonths').value)),
      feeBasis: toNum($('feeBasis').value) || 36,
      etcCost: Math.max(0, toNum($('etcCost').value) * MAN)
    };
  }

  /* --------------------------------------------------------------- 그리기 */

  function render() {
    var input = readInput();

    /* 보조 문구 */
    $('principal-kor').textContent = input.principal > 0 ? fmtKrw(input.principal) : '0원';
    $('housePrice-label').textContent = input.loanType === 'jeonse' ? '보증금 (전세보증금)' : '집값 (매매가·시세)';
    $('term-kor').textContent = state.months > 0 ? termLabel(state.months) + ' 남음 (' + state.months + '개월)' : '기간을 입력해 주세요';

    var diff = input.rateNew - input.rateNow;
    var rateDiffEl = $('rate-diff');
    rateDiffEl.textContent = '금리 차이 ' + (diff > 0 ? '+' : diff < 0 ? '−' : '') + Math.abs(diff).toFixed(2) + '%p' +
      (diff < 0 ? ' (낮아짐)' : diff > 0 ? ' (높아짐)' : '');
    rateDiffEl.className = 'hint' + (diff < 0 ? ' hint--good' : diff > 0 ? ' hint--warn' : '');

    var usesGraduated = input.methodNow === 'graduated' || input.methodNew === 'graduated';
    $('step-field').hidden = !usesGraduated;
    $('ltv-pick').hidden = input.loanType === 'jeonse';

    $('method-hint').textContent = methodHint(input);

    if (input.principal <= 0 || state.months < 1) {
      renderEmpty(input);
      return;
    }

    var r = computeLoan(input);
    state.last = r;

    renderFee(input, r);
    renderVerdict(r);
    renderStats(r);
    renderLtv(r);
    renderPaymentChart(r);
    renderProfitChart($('chart'), r.series, state.months, r.breakeven, r.net);
    renderTable(r);
    renderChartNote(r);
    renderStepHint(input, r);

    $('fee-chips').querySelectorAll('[data-fee-months]').forEach(function (b) {
      b.classList.toggle('is-active', Number(b.dataset.feeMonths) === input.feeMonths);
    });
    $('step-chips').querySelectorAll('[data-step]').forEach(function (b) {
      b.classList.toggle('is-active', Math.abs(Number(b.dataset.step) - input.stepRate) < 0.001);
    });
  }

  function methodHint(input) {
    var a = input.methodNow, b = input.methodNew;
    var base = {
      equal: '매달 같은 금액을 내는 방식이에요. (원금+이자)',
      principal: '원금은 매달 똑같이, 이자는 줄어드는 방식이에요.',
      bullet: '매달 이자만 내고, 만기에 원금을 한 번에 갚는 방식이에요.',
      graduated: '첫해에 적게 내고 1년마다 체증률만큼 오르는 방식이에요.'
    }[b];
    if (a !== b) {
      return '지금은 ' + METHOD_NAME[a] + ', 갈아타면 ' + METHOD_NAME[b] + '으로 계산해요. ' + base;
    }
    return base;
  }

  function renderStepHint(input, r) {
    var el = $('step-hint');
    if (input.methodNow !== 'graduated' && input.methodNew !== 'graduated') return;
    el.className = 'hint';
    if (r && (r.current.negAmort || r.next.negAmort)) {
      el.textContent = '체증률이 높아 첫해 납입금이 이자보다 적어요. 초반 몇 년은 원금이 오히려 늘어나요.';
      el.className = 'hint hint--warn';
    } else {
      el.textContent = '1년마다 월 납입금이 이 비율만큼 올라가요. 보금자리론·디딤돌은 매월 일정 금액씩 오르는 방식이라 금액이 조금 달라요.';
    }
  }

  function renderFee(input, r) {
    var el = $('fee-preview');
    if (input.feeRate <= 0 || input.feeMonths <= 0) {
      el.innerHTML = '중도상환수수료 없음<small>면제 조건이거나 요율이 0%로 입력됐어요.</small>';
      return;
    }
    var pct = (input.feeRate * r.feeRatio);
    el.innerHTML = '예상 중도상환수수료 ' + fmtKrw(r.fee) +
      '<small>' + input.feeRate.toFixed(2) + '% × (' + input.feeMonths + '개월 ÷ ' +
      input.feeBasis + '개월) = 실질 ' + pct.toFixed(2) + '% · ' + fmtWon(r.fee) + '</small>';
  }

  function renderVerdict(r) {
    var box = $('verdict');
    var badge = $('verdict-badge');
    var title = $('verdict-title');
    var sub = $('verdict-sub');
    var net = r.net;
    var be = r.breakeven;
    var horizon = termLabel(state.months);
    var switched = !r.sameMethod
      ? METHOD_NAME[r.input.methodNow] + ' → ' + withRo(METHOD_NAME[r.input.methodNew]) + ' 바꿔서 '
      : '';

    if (Math.abs(net) < 1) {
      box.dataset.state = 'flat';
      badge.textContent = '이득도 손해도 없어요';
      title.textContent = '지금 조건이면 갈아탈 이유가 없어요';
      sub.textContent = '금리 차이로 아끼는 이자와 수수료·비용이 비슷해요.';
      return;
    }

    if (net < 0) {
      box.dataset.state = 'bad';
      badge.textContent = '지금은 갈아타면 손해예요';
      title.textContent = '지금 갈아타면 ' + fmtKrw(Math.abs(net)) + ' 손해예요';
      sub.textContent = r.input.rateNew >= r.input.rateNow
        ? '갈아탈 금리가 지금 금리보다 높아요. 금리를 다시 확인해 보세요.'
        : switched + '이자 ' + fmtKrw(r.interestSaving) + '을 아껴도 수수료·비용 ' + fmtKrw(r.upfront) + '이 더 커요.';
      return;
    }

    if (be && be <= 12) {
      box.dataset.state = 'good';
      badge.textContent = '갈아타는 게 이득이에요';
      title.textContent = horizon + ' 동안 ' + fmtKrw(net) + '을 아껴요';
      sub.textContent = r.upfront > 0
        ? switched + '중도상환수수료·비용 ' + fmtKrw(r.upfront) + '을 내고도 ' + be + '개월이면 본전을 찾아요.'
        : '드는 비용이 없어서 첫 달부터 바로 이득이에요.';
      return;
    }

    box.dataset.state = 'warn';
    badge.textContent = '수수료 때문에 본전까지 ' + be + '개월 걸려요';
    title.textContent = '이득은 맞지만, 본전까지 ' + be + '개월 걸려요';
    sub.textContent = switched + '남은 기간 ' + horizon + ' 동안 ' + fmtKrw(net) + '이 남아요. 그 전에 또 갈아탈 계획이라면 다시 계산해 보세요.';
  }

  function renderStats(r) {
    var netEl = $('stat-net');
    netEl.textContent = fmtSigned(r.net) + ' 원';
    netEl.className = 'stat-value ' + (r.net > 0 ? 'is-down' : r.net < 0 ? 'is-up' : '');
    $('stat-net-sub').textContent = '이자 절감 ' + fmtShort(r.interestSaving) + ' − 비용 ' + fmtShort(r.upfront);

    var label = $('stat-monthly-label');
    label.textContent = r.monthlyNext.label;
    var mDiff = r.monthlyNext.value - r.monthlyCurrent.value;
    var mEl = $('stat-monthly');
    mEl.textContent = fmtSignedPrecise(mDiff) + '원';
    mEl.className = 'stat-value ' + (mDiff < -0.5 ? 'is-down' : mDiff > 0.5 ? 'is-up' : '');
    $('stat-monthly-sub').textContent = fmtWon(r.monthlyCurrent.value) + ' → ' + fmtWon(r.monthlyNext.value);

    var be = r.breakeven;
    var beEl = $('stat-breakeven');
    if (be) {
      beEl.textContent = be + '개월';
      beEl.className = 'stat-value is-down';
      $('stat-breakeven-sub').textContent = '지금 갈아타면 ' + termLabel(be) + ' 뒤 본전';
    } else {
      beEl.textContent = '없음';
      beEl.className = 'stat-value is-up';
      $('stat-breakeven-sub').textContent = '만기(' + termLabel(state.months) + ')까지 본전을 못 찾아요';
    }
  }

  function renderLtv(r) {
    var card = $('ltv-card');
    var badge = $('ltv-badge');
    var note = $('ltv-note');
    var fill = $('ltv-fill');
    var mark = $('ltv-mark');
    var title = $('ltv-label');
    var limit = r.ltvLimit;
    var basisName = r.isJeonse ? '보증금 80%' : (LTV_BASIS_LABEL[r.input.ltvBasis] || '기준 ' + limit + '%');

    title.textContent = r.isJeonse ? '보증금 대비 대출 비율' : 'LTV (담보인정비율)';

    if (r.ltv === null) {
      card.dataset.state = 'none';
      $('ltv-inline').className = 'hint';
      $('ltv-inline').textContent = r.isJeonse ? '보증금을 넣으면 비율을 계산해요' : '집값을 넣으면 LTV를 계산해요';
      badge.textContent = r.isJeonse ? '보증금 대비 —' : 'LTV —';
      note.textContent = r.isJeonse ? '보증금을 입력해 주세요.' : '집값을 입력해 주세요.';
      fill.style.width = '0%';
      mark.style.left = '100%';
      $('ltv-meter').setAttribute('aria-label', 'LTV 계산 대기');
      return;
    }

    var ltv = r.ltv;
    var gap = r.ltvGap;
    var margin = limit - ltv;
    var st = margin < 0 ? 'bad' : margin < 5 ? 'warn' : 'good';
    card.dataset.state = st;

    var word = r.isJeonse ? '보증금 대비' : 'LTV';
    badge.textContent = word + ' ' + fmtPct(ltv) + ' · ' + basisName + (margin < 0 ? ' 초과' : ' 이내');

    var inline = $('ltv-inline');
    inline.className = 'hint ' + (st === 'bad' ? 'hint--warn' : 'hint--strong');
    inline.textContent = (r.isJeonse ? '보증금 대비 ' : 'LTV ') + fmtPct(ltv) + ' · ' +
      basisName + (margin < 0 ? ' 초과' : ' 이내');

    /* 미터: 0 ~ max(기준×1.25, 현재 LTV) 스케일 */
    var scale = Math.max(limit * 1.25, ltv * 1.08, 10);
    fill.style.width = clamp((ltv / scale) * 100, 0, 100).toFixed(1) + '%';
    mark.style.left = clamp((limit / scale) * 100, 1, 99.5).toFixed(1) + '%';
    $('ltv-meter').setAttribute('aria-label',
      word + ' ' + fmtPct(ltv) + ', 기준 ' + limit + '%, ' + (margin < 0 ? '기준 초과' : '기준 이내'));

    var maxTxt = fmtShort(r.ltvMax);
    if (margin < 0) {
      note.textContent = (r.isJeonse ? '보증금' : '집값') + ' ' + fmtShort(r.input.housePrice) + ' 기준 ' + limit + '%는 ' +
        maxTxt + '인데, 남은 원금이 ' + fmtShort(Math.abs(gap)) + ' 더 많아요.';
    } else {
      note.textContent = (r.isJeonse ? '보증금' : '집값') + ' ' + fmtShort(r.input.housePrice) + ' 기준 최대 ' + maxTxt +
        '까지 · 남은 원금 ' + fmtShort(r.input.principal) + ' (여유 ' + fmtShort(gap) + ')';
    }
  }

  function renderTable(r) {
    var m1Diff = r.next.firstYear.avg - r.current.firstYear.avg;
    setCell('row-method-now', METHOD_NAME[r.input.methodNow], '');
    setCell('row-method-new', METHOD_NAME[r.input.methodNew], '');

    setCell('row-m1-now', fmtPrecise(r.current.firstYear.avg), '');
    setCell('row-m1-new', fmtPrecise(r.next.firstYear.avg), '');
    setCell('row-m1-diff', fmtSignedPrecise(m1Diff), diffClass(m1Diff, true));

    var mlDiff = r.next.lastYear.avg - r.current.lastYear.avg;
    setCell('row-mlast-now', fmtPrecise(r.current.lastYear.avg), '');
    setCell('row-mlast-new', fmtPrecise(r.next.lastYear.avg), '');
    setCell('row-mlast-diff', fmtSignedPrecise(mlDiff), diffClass(mlDiff, true));

    setCell('row-monthly-now', fmtPrecise(r.current.avgPayment), '');
    setCell('row-monthly-new', fmtPrecise(r.next.avgPayment), '');
    var mDiff = r.next.avgPayment - r.current.avgPayment;
    setCell('row-monthly-diff', fmtSignedPrecise(mDiff), diffClass(mDiff, true));

    setCell('row-int-now', fmtShort(r.current.totalInterest), '');
    setCell('row-int-new', fmtShort(r.next.totalInterest), '');
    setCell('row-int-diff', fmtSigned(-(r.interestSaving)), diffClass(-(r.interestSaving), true));

    var tDiff = r.next.totalRepay - r.current.totalRepay;
    setCell('row-total-now', fmtShort(r.current.totalRepay), '');
    setCell('row-total-new', fmtShort(r.next.totalRepay), '');
    setCell('row-total-diff', fmtSigned(tDiff), diffClass(tDiff, true));

    setCell('row-cost-now', '0', '');
    setCell('row-cost-new', fmtShort(r.upfront), '');
    setCell('row-cost-diff', r.upfront > 0 ? '+' + fmtShort(r.upfront) : '0', r.upfront > 0 ? 'is-bad' : 'is-none');

    setCell('row-net-now', '—', 'is-none');
    var netCls = r.net > 0.5 ? 'is-good' : r.net < -0.5 ? 'is-bad' : 'is-none';
    setCell('row-net-new', fmtSigned(r.net), netCls);
    setCell('row-net-diff', fmtSigned(r.net), netCls);

    var lines = [];
    lines.push(termLabel(state.months) + ' 동안 같은 원금·같은 기간으로 비교했어요. 상환방식은 지금 ' +
      methodLabel(r.input.methodNow, r.current.stepRate) + ' / 갈아타기 ' +
      methodLabel(r.input.methodNew, r.next.stepRate) + ' 조합으로 계산했어요.');
    if (r.input.methodNow === 'graduated' || r.input.methodNew === 'graduated') {
      lines.push('체증식은 1년마다 체증률 ' + r.input.stepRate + '%씩 월 납입금이 오르는 모델이에요. 보금자리론·디딤돌은 매월 일정액씩 오르는 방식이라 금액이 조금 달라요.');
    }
    lines.push('중도상환수수료 ' + fmtShort(r.fee) + ' + 기타 비용 ' + fmtShort(r.input.etcCost) + ' = ' + fmtShort(r.upfront) + '을 갈아타는 시점에 현금으로 내는 것으로 계산했어요.');
    lines.push('표의 금액 단위는 원이고, 억·만 단위로 줄여 표시했어요.');

    $('assumptions').innerHTML = lines.map(function (t) { return '<li>' + t + '</li>'; }).join('');
  }

  function setCell(id, text, cls) {
    var el = $(id);
    el.textContent = text;
    el.className = cls || '';
  }

  function diffClass(v, lowerIsBetter) {
    if (Math.abs(v) <= 0.5) return 'is-none';
    var good = lowerIsBetter ? v < 0 : v > 0;
    return good ? 'is-good' : 'is-bad';
  }

  function renderChartNote(r) {
    var note = $('chart-note');
    if (r.breakeven) {
      note.textContent = '처음엔 수수료·비용 ' + fmtShort(r.upfront) + '만큼 마이너스에서 시작해요. ' +
        r.breakeven + '개월째에 0을 넘고, 만기까지 ' + fmtShort(r.net) + '이 남아요.';
    } else {
      note.textContent = '수수료·비용을 메우지 못해 만기까지 마이너스예요. 이 조건이면 갈아타지 않는 편이 나아요.';
    }
  }

  function renderPaymentChart(r) {
    var note = $('payment-note');
    var now = r.current, next = r.next;
    var parts = [];
    parts.push('지금 대출은 1년차 ' + fmtWon(now.firstYear.avg) + '에서 마지막 해 ' + fmtWon(now.lastYear.avg) + '으로');
    parts.push(now.lastYear.avg > now.firstYear.avg + 1
      ? ' 올라가요.'
      : now.lastYear.avg < now.firstYear.avg - 1 ? ' 내려가요.' : ' 그대로예요.');
    if (r.sameMethod && now.rate === next.rate) {
      parts.push(' 두 대출이 같은 방식·같은 금리라 겹쳐 보여요.');
    } else {
      parts.push(' 갈아타면 1년차 ' + fmtWon(next.firstYear.avg) + ', 마지막 해 ' + fmtWon(next.lastYear.avg) + '이에요.');
    }
    note.textContent = parts.join('');
    drawPaymentChart($('payment-chart'), now, next);
  }

  function renderEmpty(input) {
    state.last = null;
    var box = $('verdict');
    box.dataset.state = 'flat';
    $('verdict-badge').textContent = '입력 대기';
    $('verdict-title').textContent = '남은 원금과 기간을 넣어 주세요';
    $('verdict-sub').textContent = '값을 넣는 즉시 결과가 나와요.';

    ['stat-net', 'stat-monthly', 'stat-breakeven'].forEach(function (id) {
      $(id).textContent = '—';
      $(id).className = 'stat-value';
    });
    $('stat-net-sub').textContent = '';
    $('stat-monthly-sub').textContent = '';
    $('stat-breakeven-sub').textContent = '';
    $('stat-monthly-label').textContent = '월 납입금';

    $('chart').innerHTML = '<p class="chart-empty">값을 입력하면 누적 순이익 그래프가 그려져요.</p>';
    $('payment-chart').innerHTML = '<p class="chart-empty">값을 입력하면 월 납입금 흐름이 그려져요.</p>';
    $('chart-note').textContent = '';
    $('payment-note').textContent = '';

    /* LTV는 원금이 0이어도 집값만 있으면 계산해 준다 */
    var ltv = input.housePrice > 0 ? 0 : null;
    renderLtv({ ltv: ltv, ltvLimit: input.loanType === 'jeonse' ? JEONSE_LTV_LIMIT : parseFloat(input.ltvBasis) || 70,
      ltvMax: input.housePrice * ((input.loanType === 'jeonse' ? JEONSE_LTV_LIMIT : parseFloat(input.ltvBasis) || 70) / 100),
      ltvGap: input.housePrice * ((input.loanType === 'jeonse' ? JEONSE_LTV_LIMIT : parseFloat(input.ltvBasis) || 70) / 100),
      isJeonse: input.loanType === 'jeonse', input: input, current: null, next: null });

    ['row-method-now','row-method-new','row-m1-now','row-m1-new','row-m1-diff','row-mlast-now','row-mlast-new','row-mlast-diff',
     'row-monthly-now','row-monthly-new','row-monthly-diff','row-int-now','row-int-new','row-int-diff',
     'row-total-now','row-total-new','row-total-diff','row-cost-now','row-cost-new','row-cost-diff',
     'row-net-now','row-net-new','row-net-diff'].forEach(function (id) {
      setCell(id, '—', 'is-none');
    });
    $('fee-preview').textContent = '원금과 기간을 입력하면 예상 수수료가 나와요.';
  }

  /* ----------------------------------------------------------- SVG 차트 */

  function niceStep(raw) {
    if (!isFinite(raw) || raw <= 0) return 1;
    var pow = Math.pow(10, Math.floor(Math.log10(raw)));
    var n = raw / pow;
    var mult = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return mult * pow;
  }

  function renderProfitChart(container, series, months, breakeven, finalNet) {
    if (!container || months < 1 || !series.length) return;

    var W = Math.max(300, Math.round(container.clientWidth || 320));
    var H = W < 460 ? 208 : 236;
    var L = W < 380 ? 46 : 58;
    var R = 14, T = 16, B = 28;
    var innerW = W - L - R;
    var innerH = H - T - B;

    var yMax = 0, yMin = 0;
    for (var k = 0; k < series.length; k++) {
      if (series[k].net > yMax) yMax = series[k].net;
      if (series[k].net < yMin) yMin = series[k].net;
    }
    if (yMax - yMin < 1) { yMax = 1; yMin = 0; }
    var pad = (yMax - yMin) * 0.12;
    var step = niceStep((yMax - yMin + pad * 2) / 4);
    var yTop = Math.ceil((yMax + pad) / step) * step;
    var yBot = Math.floor((yMin - pad) / step) * step;
    if (yBot === yTop) yTop = yBot + step;

    var X = function (m) { return L + (m / months) * innerW; };
    var Y = function (v) { return T + ((yTop - v) / (yTop - yBot)) * innerH; };
    var y0 = Y(0);

    var svg = [];
    svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" role="presentation">');
    svg.push('<defs>');
    svg.push('<linearGradient id="fillUp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0e9f6e" stop-opacity="0.24"/><stop offset="1" stop-color="#0e9f6e" stop-opacity="0.02"/></linearGradient>');
    svg.push('<linearGradient id="fillDown" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c62828" stop-opacity="0.04"/><stop offset="1" stop-color="#c62828" stop-opacity="0.16"/></linearGradient>');
    svg.push('<clipPath id="clipUp"><rect x="0" y="0" width="' + W + '" height="' + Math.max(0, y0) + '"/></clipPath>');
    svg.push('<clipPath id="clipDown"><rect x="0" y="' + Math.max(0, y0) + '" width="' + W + '" height="' + Math.max(0, H - y0) + '"/></clipPath>');
    svg.push('</defs>');

    /* 가로 그리드 + y축 눈금 */
    for (var v = yBot; v <= yTop + step / 2; v += step) {
      var y = Y(v);
      var isZero = Math.abs(v) < step / 1000;
      svg.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y.toFixed(1) +
        '" stroke="' + (isZero ? '#c2cee0' : '#eef2f8') + '" stroke-width="1"/>');
      svg.push('<text x="' + (L - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" font-size="10.5" fill="' +
        (isZero ? '#7d90aa' : '#9aabc2') + '">' + (isZero ? '0' : fmtShort(v)) + '</text>');
    }

    /* x축 눈금 */
    var ticks = [0, 0.25, 0.5, 0.75, 1].map(function (p) { return Math.round(months * p); });
    var seen = {};
    for (var t = 0; t < ticks.length; t++) {
      var mv = ticks[t];
      if (seen[mv]) continue;
      seen[mv] = 1;
      var tx = X(mv);
      svg.push('<text x="' + tx.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' +
        (mv === 0 ? 'start' : mv === months ? 'end' : 'middle') + '" font-size="10.5" fill="#9aabc2">' + mv + '</text>');
    }

    /* 누적 선 */
    var d = 'M ' + X(0).toFixed(1) + ' ' + Y(series[0].net).toFixed(1);
    for (var p = 1; p < series.length; p++) {
      d += ' L ' + X(series[p].m).toFixed(1) + ' ' + Y(series[p].net).toFixed(1);
    }
    var area = d + ' L ' + X(months).toFixed(1) + ' ' + y0.toFixed(1) + ' L ' + X(0).toFixed(1) + ' ' + y0.toFixed(1) + ' Z';

    svg.push('<path d="' + area + '" fill="url(#fillUp)" clip-path="url(#clipUp)"/>');
    svg.push('<path d="' + area + '" fill="url(#fillDown)" clip-path="url(#clipDown)"/>');
    svg.push('<path d="' + d + '" fill="none" stroke="#0e9f6e" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#clipUp)"/>');
    svg.push('<path d="' + d + '" fill="none" stroke="#c62828" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" clip-path="url(#clipDown)"/>');

    /* 0선 강조 */
    svg.push('<line x1="' + L + '" y1="' + y0.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y0.toFixed(1) +
      '" stroke="#93a6c0" stroke-width="1.2" stroke-dasharray="4 3"/>');

    /* 시작점 (수수료 낸 직후) */
    var startX = X(0), startY = Y(series[0].net);
    if (!breakeven || Math.abs(X(breakeven) - startX) > 16) {
      svg.push('<circle cx="' + startX.toFixed(1) + '" cy="' + startY.toFixed(1) + '" r="3.4" fill="#c62828"/>');
    }

    /* 손익분기점 */
    if (breakeven && series[breakeven]) {
      var bx = X(breakeven);
      var by = Y(series[breakeven].net);
      svg.push('<line x1="' + bx.toFixed(1) + '" y1="' + by.toFixed(1) + '" x2="' + bx.toFixed(1) + '" y2="' + y0.toFixed(1) +
        '" stroke="#0e9f6e" stroke-width="1.4" stroke-dasharray="3 3" opacity="0.75"/>');
      svg.push('<circle cx="' + bx.toFixed(1) + '" cy="' + by.toFixed(1) + '" r="4.6" fill="#fff" stroke="#0e9f6e" stroke-width="2.4"/>');
      var labelRight = bx < W * 0.72;
      var ly = (y0 + 19 <= H - 8) ? y0 + 19 : y0 - 11;
      svg.push('<text class="halo" x="' + (bx + (labelRight ? 10 : -10)).toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="' +
        (labelRight ? 'start' : 'end') + '" font-size="11.5" font-weight="800" fill="#0a7d56">본전 ' + breakeven + '개월</text>');
    }

    /* 마지막 점 */
    var last = series[series.length - 1];
    svg.push('<circle cx="' + X(last.m).toFixed(1) + '" cy="' + Y(last.net).toFixed(1) + '" r="3.6" fill="' +
      (last.net >= 0 ? '#0e9f6e' : '#c62828') + '"/>');

    svg.push('</svg>');
    container.innerHTML = svg.join('');
    container.setAttribute('aria-label',
      '개월 수에 따른 누적 순이익 그래프. ' + (breakeven ? breakeven + '개월째 본전, 만기까지 ' + fmtKrw(finalNet) : '만기까지 본전을 못 찾음'));
  }

  /* 월 납입금 흐름: 연 단위 두 줄 */
  function drawPaymentChart(container, now, next) {
    if (!container || !now.yearly.length) return;
    var years = Math.max(now.yearly.length, next.yearly.length);
    var W = Math.max(300, Math.round(container.clientWidth || 320));
    var H = W < 460 ? 196 : 220;
    var L = W < 380 ? 48 : 60;
    var R = 16, T = 18, B = 26;
    var innerW = W - L - R, innerH = H - T - B;

    var vals = [];
    now.yearly.forEach(function (y) { vals.push(y.avg); });
    next.yearly.forEach(function (y) { vals.push(y.avg); });
    var vMin = Math.min.apply(null, vals), vMax = Math.max.apply(null, vals);
    if (vMax - vMin < 1) { vMin = Math.max(0, vMin - 1); vMax = vMin + 2; }
    var padV = (vMax - vMin) * 0.18;
    var lo = Math.max(0, vMin - padV), hi = vMax + padV;

    var X = function (yr) { return years <= 1 ? L + innerW / 2 : L + ((yr - 1) / (years - 1)) * innerW; };
    var Y = function (v) { return T + ((hi - v) / (hi - lo)) * innerH; };

    var svg = [];
    svg.push('<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" role="presentation">');

    var step = niceStep((hi - lo) / 3);
    var tickStart = Math.ceil(lo / step) * step;
    for (var v = tickStart; v <= hi; v += step) {
      var y = Y(v);
      svg.push('<line x1="' + L + '" y1="' + y.toFixed(1) + '" x2="' + (W - R) + '" y2="' + y.toFixed(1) + '" stroke="#eef2f8" stroke-width="1"/>');
      svg.push('<text x="' + (L - 8) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="end" font-size="10.5" fill="#9aabc2">' + fmtShort(v) + '</text>');
    }

    /* 세로 연차선 + x축 */
    var xTicks = [1, Math.round(1 + (years - 1) * 0.5), years];
    xTicks = xTicks.filter(function (v2, i2, arr) { return arr.indexOf(v2) === i2; });
    xTicks.forEach(function (yr) {
      svg.push('<text x="' + X(yr).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="' +
        (years <= 1 ? 'middle' : yr === 1 ? 'start' : yr === years ? 'end' : 'middle') +
        '" font-size="10.5" fill="#9aabc2">' + (years <= 1 ? '1년차' : yr + '년') + '</text>');
    });

    function path(loan) {
      var d = '';
      loan.yearly.forEach(function (p, idx) {
        d += (idx === 0 ? 'M ' : ' L ') + X(p.year).toFixed(1) + ' ' + Y(p.avg).toFixed(1);
      });
      return d;
    }

    var dNow = path(now), dNew = path(next);
    svg.push('<path d="' + dNow + '" fill="none" stroke="#0f2a5f" stroke-width="2.3" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>');
    svg.push('<path d="' + dNew + '" fill="none" stroke="#0e9f6e" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>');

    /* 점 + 값 라벨 (첫해·마지막 해) */
    var range = hi - lo;
    var closeAtFirst = Math.abs(now.yearly[0].avg - next.yearly[0].avg) < range * 0.05;
    var closeAtLast = Math.abs(now.lastYear.avg - next.lastYear.avg) < range * 0.05;

    function dot(x, y, color) { return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="3.2" fill="' + color + '"/>'; }
    function label(x, y, txt, anchor, color) {
      return '<text class="halo" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="' + anchor +
        '" font-size="10.5" font-weight="800" fill="' + color + '">' + txt + '</text>';
    }

    var xn0 = X(next.yearly[0].year), yn0 = Y(next.yearly[0].avg);
    svg.push(dot(xn0, yn0, '#0e9f6e'));
    svg.push(label(xn0 + 6, yn0 + (yn0 > T + 20 ? -8 : 14), fmtWon(next.firstYear.avg), 'start', '#0a7d56'));

    var xnl = X(next.lastYear.year), ynl = Y(next.lastYear.avg);
    svg.push(dot(xnl, ynl, '#0e9f6e'));
    svg.push(label(xnl - 6, ynl + (ynl > T + 20 ? -8 : 14), fmtWon(next.lastYear.avg), 'end', '#0a7d56'));

    if (!closeAtFirst) {
      var xo0 = X(now.yearly[0].year), yo0 = Y(now.yearly[0].avg);
      svg.push(dot(xo0, yo0, '#0f2a5f'));
      svg.push(label(xo0 + 6, yo0 + (yo0 > T + 20 ? -8 : 14), fmtWon(now.firstYear.avg), 'start', '#0f2a5f'));
    }
    if (!closeAtLast) {
      var xol = X(now.lastYear.year), yol = Y(now.lastYear.avg);
      svg.push(dot(xol, yol, '#0f2a5f'));
      svg.push(label(xol - 6, yol + (yol > T + 20 ? -8 : 14), fmtWon(now.lastYear.avg), 'end', '#0f2a5f'));
    }

    svg.push('</svg>');
    container.innerHTML = svg.join('');
    container.setAttribute('aria-label',
      '연도별 월 납입금 그래프. 지금 대출 1년차 ' + fmtKrw(now.firstYear.avg) + '에서 마지막 해 ' + fmtKrw(now.lastYear.avg) +
      ', 갈아타기 1년차 ' + fmtKrw(next.firstYear.avg) + '에서 마지막 해 ' + fmtKrw(next.lastYear.avg));
  }

  /* ------------------------------------------------------------ 복사 텍스트 */

  function buildSummary(r) {
    var i = r.input;
    var typeName = i.loanType === 'jeonse' ? '전세자금대출' : '주택담보대출';
    var lines = [];
    lines.push('[대출 갈아타기 계산기 결과]');
    lines.push('· 대출: ' + typeName);
    lines.push('· 상환방식: 지금 ' + methodLabel(i.methodNow, r.current.stepRate) + ' → 갈아타기 ' + methodLabel(i.methodNew, r.next.stepRate));
    lines.push('· 남은 원금: ' + fmtKrw(i.principal) + ' / 남은 기간: ' + termLabel(state.months) + ' (' + state.months + '개월)');
    if (r.ltv !== null) {
      lines.push('· ' + (r.isJeonse ? '보증금' : '집값') + ': ' + fmtKrw(i.housePrice) + ' / LTV: ' + fmtPct(r.ltv) + ' (기준 ' + r.ltvLimit + '%)');
    }
    lines.push('· 금리: 연 ' + i.rateNow.toFixed(2) + '% → 연 ' + i.rateNew.toFixed(2) + '%');
    lines.push('· 예상 중도상환수수료: ' + fmtKrw(r.fee) + ' (수수료율 ' + i.feeRate.toFixed(2) + '% × ' + i.feeMonths + '/' + i.feeBasis + '개월)');
    lines.push('· 기타 비용: ' + fmtKrw(i.etcCost));
    lines.push('· 총 이자: ' + fmtKrw(r.current.totalInterest) + ' → ' + fmtKrw(r.next.totalInterest) + ' (절감 ' + fmtKrw(r.interestSaving) + ')');
    lines.push('· 1년차 월 납입금: ' + fmtWon(r.current.firstYear.avg) + ' → ' + fmtWon(r.next.firstYear.avg) +
      ' (' + fmtSignedPrecise(r.next.firstYear.avg - r.current.firstYear.avg) + '원)');
    lines.push('· 마지막 해 월 납입금: ' + fmtWon(r.current.lastYear.avg) + ' → ' + fmtWon(r.next.lastYear.avg) +
      ' (' + fmtSignedPrecise(r.next.lastYear.avg - r.current.lastYear.avg) + '원)');
    lines.push('· 최종 순이익: ' + fmtSigned(r.net) + ' 원');
    lines.push('· 손익분기점: ' + (r.breakeven ? r.breakeven + '개월' : '만기까지 없음'));
    lines.push('· 3개월 뒤 순이익: ' + (r.series[Math.min(3, state.months)] ? fmtKrw(r.series[Math.min(3, state.months)].net) : '—'));
    lines.push('');
    lines.push('※ 같은 원금·같은 남은 기간 기준 단순 비교입니다. 실제 조건은 금융기관 안내로 확인하세요.');
    return lines.join('\n');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('copy failed'));
      } catch (e) { reject(e); }
    });
  }

  /* ------------------------------------------------------------- 이벤트 */

  function syncTermMonths() {
    var unit = $('termUnit').value;
    var v = toNum($('term').value);
    var months = unit === 'years' ? Math.round(v * 12) : Math.round(v);
    if (months < 0) months = 0;
    if (months > MAX_MONTHS) months = MAX_MONTHS;
    state.months = months;
  }

  function setTerm(months) {
    state.months = months;
    var unit = $('termUnit').value;
    $('term').value = unit === 'years' ? (months % 12 === 0 ? months / 12 : +(months / 12).toFixed(2)) : months;
  }

  function init() {
    /* 입력 즉시 계산 */
    ['principal','rateNow','rateNew','feeRate','feeMonths','etcCost','housePrice','stepRate'].forEach(function (id) {
      $(id).addEventListener('input', render);
      $(id).addEventListener('change', render);
    });
    $('feeBasis').addEventListener('change', render);
    $('ltvBasis').addEventListener('change', render);
    $('term').addEventListener('input', function () { syncTermMonths(); render(); });

    $('termUnit').addEventListener('change', function () {
      var unit = $('termUnit').value;
      if (state.months > 0) {
        $('term').value = unit === 'years'
          ? (state.months % 12 === 0 ? state.months / 12 : +(state.months / 12).toFixed(2))
          : state.months;
      }
      render();
    });

    /* 대출 종류를 바꾸면 상환방식 기본값을 따라 바꾼다 (체증식을 고른 상태면 그대로 둔다) */
    document.querySelectorAll('input[name="loanType"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        var want = this.value === 'jeonse' ? 'bullet' : 'equal';
        var usesGraduated = radioValue('methodNow') === 'graduated' || radioValue('methodNew') === 'graduated';
        if (!usesGraduated) {
          document.querySelectorAll('input[name="methodNow"], input[name="methodNew"]').forEach(function (el) {
            el.checked = el.value === want;
          });
        }
        render();
      });
    });
    document.querySelectorAll('input[name="methodNow"], input[name="methodNew"]').forEach(function (radio) {
      radio.addEventListener('change', render);
    });

    /* 원금 빠른 버튼 */
    document.querySelectorAll('[data-add]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var cur = toNum($('principal').value);
        var add = btn.dataset.add;
        if (add === 'reset') { $('principal').value = 0; }
        else { $('principal').value = Math.min(1000000, cur + Number(add)); }
        render();
      });
    });

    /* 수수료 잔존기간 칩 */
    $('fee-chips').querySelectorAll('[data-fee-months]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        $('feeMonths').value = chip.dataset.feeMonths;
        render();
      });
    });

    /* 체증률 칩 */
    $('step-chips').querySelectorAll('[data-step]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        $('stepRate').value = Number(chip.dataset.step).toFixed(1);
        render();
      });
    });

    /* 예시 프리셋 */
    document.querySelectorAll('[data-preset]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        applyPreset(btn.dataset.preset);
      });
    });

    /* 복사 */
    $('copy-btn').addEventListener('click', function () {
      if (!state.last) {
        $('copy-state').textContent = '값을 먼저 입력해 주세요';
        return;
      }
      var text = buildSummary(state.last);
      copyText(text).then(function () {
        $('copy-state').textContent = '결과를 복사했어요';
        setTimeout(function () { $('copy-state').textContent = ''; }, 2600);
      }).catch(function () {
        $('copy-state').textContent = '복사가 안 되면 결과 화면을 직접 선택해 주세요';
      });
    });

    /* 창 크기가 바뀌면 차트만 다시 */
    var rt;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () {
        if (!state.last) return;
        renderProfitChart($('chart'), state.last.series, state.months, state.last.breakeven, state.last.net);
        drawPaymentChart($('payment-chart'), state.last.current, state.last.next);
      }, 160);
    });

    /* 폼 안에서 Enter로 페이지가 새로고침되지 않게 */
    $('calc-form').addEventListener('submit', function (e) { e.preventDefault(); });

    setTerm(360);
    render();
  }

  function setRadio(name, value) {
    var el = document.querySelector('input[name="' + name + '"][value="' + value + '"]');
    if (el) el.checked = true;
  }

  function applyPreset(name) {
    var p;
    if (name === 'jeonse') {
      p = { type: 'jeonse', now: 'bullet', next: 'bullet', principal: 20000, house: 30000, months: 24,
            rateNow: 4.5, rateNew: 3.6, step: 3, feeRate: 0, feeMonths: 0, feeBasis: 36, etc: 0 };
    } else if (name === 'graduated') {
      p = { type: 'mortgage', now: 'equal', next: 'graduated', principal: 40000, house: 70000, months: 360,
            rateNow: 4.6, rateNew: 3.7, step: 3, feeRate: 1.2, feeMonths: 24, feeBasis: 36, etc: 7.5 };
    } else {
      p = { type: 'mortgage', now: 'equal', next: 'equal', principal: 40000, house: 70000, months: 300,
            rateNow: 4.8, rateNew: 3.7, step: 3, feeRate: 1.2, feeMonths: 18, feeBasis: 36, etc: 7.5 };
    }

    setRadio('loanType', p.type);
    setRadio('methodNow', p.now);
    setRadio('methodNew', p.next);

    $('principal').value = p.principal;
    $('housePrice').value = p.house;
    $('ltvBasis').value = '70';
    setTerm(p.months);
    $('rateNow').value = p.rateNow.toFixed(2);
    $('rateNew').value = p.rateNew.toFixed(2);
    $('stepRate').value = p.step.toFixed(1);
    $('feeRate').value = p.feeRate.toFixed(2);
    $('feeMonths').value = p.feeMonths;
    $('feeBasis').value = String(p.feeBasis);
    $('etcCost').value = p.etc;
    render();
    if (window.innerWidth >= 1000) {
      document.getElementById('results').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  /* 테스트·검증용 공개 */
  window.LoanCalc = {
    buildSchedule: buildSchedule,
    computeLoan: computeLoan,
    levelPayment: levelPayment,
    graduatedFirstPayment: graduatedFirstPayment,
    methodLabel: methodLabel,
    fmtShort: fmtShort,
    fmtNum: fmtNum,
    fmtPct: fmtPct,
    termLabel: termLabel,
    getState: function () { return state; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
