(function(root) {
  'use strict';
  const PAIRS = {
    'EUR/USD': { base: 1.08450, spread: 1.2, pip: 0.0001, vol: 1, name: 'Euro / US dollar' },
    'GBP/USD': { base: 1.27420, spread: 1.8, pip: 0.0001, vol: 1.3, name: 'British pound / US dollar' },
    'AUD/USD': { base: 0.66320, spread: 1.5, pip: 0.0001, vol: 0.9, name: 'Australian dollar / US dollar' },
    'NZD/USD': { base: 0.61150, spread: 1.9, pip: 0.0001, vol: 1.1, name: 'NZ dollar / US dollar' }
  };
  const SCENARIOS = ['Uptrend', 'Downtrend', 'Range', 'News shock'];
  const money = n => Number(n || 0).toLocaleString('en-US', { style:'currency', currency:'USD', minimumFractionDigits:2, maximumFractionDigits:2 });
  const round = (n, d=2) => Number(n.toFixed(d));
  const pipValue = (lots, pair) => {
    if (!PAIRS[pair]) throw new Error('Pair not supported');
    return lots * 100000 * PAIRS[pair].pip;
  };
  // All pairs are XXX/USD. Pip values and P&L are already in the account's USD currency.
  function positionSize(equity, riskPct, stopPips, pair) {
    if (!(equity > 0 && riskPct > 0 && riskPct <= 1 && stopPips > 0 && PAIRS[pair])) return null;
    const budget = equity * riskPct / 100;
    const raw = budget / (stopPips * pipValue(1, pair));
    const lots = Math.floor((raw + 1e-9) * 100) / 100;
    if (lots < 0.01) return { lots: 0, budget: round(budget), actualRisk: 0, riskPctActual: 0, margin: 0 };
    const actualRisk = stopPips * pipValue(lots, pair);
    return { lots: round(lots, 2), budget: round(budget), actualRisk: round(actualRisk), riskPctActual: round(actualRisk/equity*100, 3), margin: 0 };
  }
  function rng(seed) { let v = (seed>>>0) || 91327; return () => { v ^= v<<13; v ^= v>>>17; v ^= v<<5; return (v>>>0) / 4294967296; }; }
  function generateMarket(pair='EUR/USD', scenario='Uptrend', seed=16, count=420) {
    const cfg=PAIRS[pair];
    if (!cfg || !SCENARIOS.includes(scenario)) throw new Error('Unsupported market');
    const random=rng(seed);
    const candles=[];
    let price=cfg.base * (1 + (random()-.5)*.012);
    const center=price;
    const unit=cfg.pip * cfg.vol;
    for(let i=0;i<count;i++) {
      const open=price;
      let drift=0;
      const noise=(random()+random()+random()-1.5)*9*unit;
      if(scenario==='Uptrend') drift=0.95*unit;
      if(scenario==='Downtrend') drift=-0.95*unit;
      if(scenario==='Range') drift=-(price-center)*0.12;
      if(scenario==='News shock') {
        drift=(i%85<38?0.7:-0.7)*unit;
        if(i===118 || i===207 || i===309) drift += (random()>.5?1:-1)*60*unit;
      }
      if (scenario==='Uptrend' || scenario==='Downtrend') drift += Math.sin(i/21)*1.15*unit;
      price=Math.max(cfg.pip*100, open+drift+noise);
      const wiggle=(1 + random()*4.8)*unit;
      candles.push({open:round(open,5),high:round(Math.max(open,price)+wiggle,5),low:round(Math.min(open,price)-wiggle*(0.45+random()*0.55),5),close:round(price,5)});
    }
    return candles;
  }
  function spreadAt(pair, scenario, index) {
    const base=PAIRS[pair].spread;
    return round(scenario==='News shock' && ((index>113 && index<125)||(index>202 && index<214)||(index>304 && index<315)) ? base+2.8 : base,1);
  }
  function quote(mid, pair, spreadPips) { const half=spreadPips*PAIRS[pair].pip/2; return {bid:round(mid-half,5),ask:round(mid+half,5)}; }
  function floatingPL(trade, mid, spreadPips) {
    if(!trade) return 0;
    const exitQuote=quote(mid,trade.pair,spreadPips);
    const close=trade.side==='BUY'?exitQuote.bid:exitQuote.ask;
    return round((trade.side==='BUY'?1:-1)*(close-trade.entry)*100000*trade.lots,2);
  }
  function checkExit(trade,candle,spreadPips,scenario) {
    if(!trade) return null;
    const half=spreadPips*PAIRS[trade.pair].pip/2;
    const isBuy=trade.side==='BUY';
    const lowExec=isBuy?candle.low-half:candle.low+half;
    const highExec=isBuy?candle.high-half:candle.high+half;
    const openExec=isBuy?candle.open-half:candle.open+half;
    const stopHit=isBuy?lowExec<=trade.sl:highExec>=trade.sl;
    const targetHit=isBuy?highExec>=trade.tp:lowExec<=trade.tp;
    let price, reason;
    if(stopHit) {
      reason='Stop loss';
      // Conservative stop-first assumption if both levels occur within one bar.
      // Synthetic fixed adverse slippage of 1 pip in news-shock scenarios.
      const slip=scenario==='News shock'?PAIRS[trade.pair].pip:0;
      price=isBuy?Math.min(trade.sl,openExec)-slip:Math.max(trade.sl,openExec)+slip;
    } else if(targetHit) {
      reason='Take profit';price=trade.tp;
    } else return null;
    price=round(price,5);
    return {price,reason, pnl:round((isBuy?1:-1)*(price-trade.entry)*100000*trade.lots,2)};
  }
  function evaluatePerformance(trades, balanceHistory) {
    const pnl=trades.reduce((a,t)=>a+t.pnl,0);
    const wins=trades.filter(t=>t.pnl>0);
    const losses=trades.filter(t=>t.pnl<0);
    const grossProfit=wins.reduce((a,t)=>a+t.pnl,0);
    const grossLoss=-losses.reduce((a,t)=>a+t.pnl,0);
    const expectancy=trades.length?pnl/trades.length:0;
    let peak=balanceHistory[0]||10000,maxDD=0;
    for(const x of balanceHistory){peak=Math.max(peak,x);maxDD=Math.max(maxDD,(peak-x)/peak*100);}
    const journalled=trades.filter(t=>(t.reflection||'').trim().length>=15).length;
    return {pnl:round(pnl),count:trades.length,wins:wins.length,losses:losses.length,winRate:trades.length?round(wins.length/trades.length*100,1):0,profitFactor:grossLoss>0?round(grossProfit/grossLoss,2):(grossProfit>0?null:0),expectancy:round(expectancy),maxDD:round(maxDD,2),journalled,journalRate:trades.length?round(journalled/trades.length*100,1):0};
  }
  const api={PAIRS,SCENARIOS,money,round,pipValue,positionSize,generateMarket,spreadAt,quote,floatingPL,checkExit,evaluatePerformance};
  root.FXLogic=api;
  if(typeof module!=='undefined'&&module.exports) module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
