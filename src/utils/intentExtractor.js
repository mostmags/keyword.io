/**
 * Topic and Intent Extraction utility for Keyword Finder.
 * Extracts platform, primary action, action group, objects, and intent modifiers.
 * Implements strict antonym/opposing action isolation.
 */

import { cleanText, stemToken, tokenize } from './normalizer.js';

// Common tech, financial, and digital platforms
export const KNOWN_PLATFORMS = [
  // Financial, Payment & Crypto
  'robinhood', 'chime', 'afterpay', 'paypal', 'cash app', 'cashapp', 'coinbase', 
  'kraken', 'binance', 'venmo', 'stripe', 'square', 'apple pay', 'google pay', 'gpay',
  'phonepe', 'phone pe', 'paytm', 'razorpay', 'razor pay', 'quickbooks', 'quickbooks online',
  'revolut', 'zelle', 'yono sbi', 'sbi', 'hdfc', 'icici', 'axis bank', 'cred', 'bharatpe',
  'groww', 'zerodha', 'upstox', 'angel one', 'metamask', 'trust wallet', 'phantom', 'exodus',
  'tangem', 'webull', 'fidelity', 'charles schwab', 'etrade', 'crypto com', 'gemini', 'kucoin', 'bybit', 'okx',
  // Productivity, Creative & Office Tools
  'canva', 'photoshop', 'premiere pro', 'premiere', 'capcut', 'lightroom', 'figma',
  'microsoft teams', 'teams', 'slack', 'zoom', 'discord', 'telegram', 'whatsapp', 'signal',
  'ms word', 'word', 'ms excel', 'excel', 'powerpoint', 'google docs', 'google sheets', 'google drive',
  'google map', 'google maps', 'gmail', 'squarespace', 'shopify', 'wordpress', 'github',
  // Social, Media, Chat & Travel
  'botim', 'youtube', 'tiktok', 'instagram', 'facebook', 'twitter', 'snapchat', 'reddit', 'pinterest', 'threads',
  'airbnb', 'booking com', 'booking', 'amazon', 'walmart', 'ebay', 'meesho', 'flipkart', 'uber', 'lyft', 'doordash', 'instacart',
  'target', 'verizon', 'linkedin'
];

// Action synonym groups
export const ACTION_GROUPS = {
  insert: ['add', 'link', 'connect', 'attach', 'bind', 'put', 'setup', 'associate', 'pair'],
  delete: ['remove', 'unlink', 'disconnect', 'delete', 'cancel', 'unbind', 'detach', 'close', 'stop'],
  transfer_out: ['send', 'transfer', 'withdraw', 'cash out', 'pay', 'move', 'wire', 'forward'],
  transfer_in: ['receive', 'deposit', 'fund', 'request', 'accept', 'claim'],
  trade_buy: ['buy', 'purchase', 'invest', 'acquire'],
  trade_sell: ['sell', 'liquidate', 'short'],
  turn_on: ['enable', 'activate', 'turn on', 'switch on', 'unlock', 'unfreeze', 'unblock'],
  turn_off: ['disable', 'deactivate', 'turn off', 'switch off', 'lock', 'freeze', 'block'],
  auth_in: ['login', 'sign in', 'sign up', 'register', 'authenticate'],
  auth_out: ['logout', 'sign out'],
  modify: ['change', 'update', 'edit', 'switch', 'replace', 'reset'],
  view: ['check', 'view', 'see', 'find', 'track', 'show'],
  troubleshoot: ['fix', 'repair', 'troubleshoot', 'solve', 'recover', 'restore']
};

// Opposing / antonym action groups
const OPPOSING_GROUPS = [
  ['insert', 'delete'],
  ['transfer_out', 'transfer_in'],
  ['trade_buy', 'trade_sell'],
  ['turn_on', 'turn_off'],
  ['auth_in', 'auth_out']
];

// Pre-index action to group
const ACTION_TO_GROUP = new Map();
for (const [group, actions] of Object.entries(ACTION_GROUPS)) {
  for (const action of actions) {
    ACTION_TO_GROUP.set(action, group);
  }
}

// Multi-word and single-word recognized objects/features
export const KNOWN_OBJECTS = [
  'debit card', 'credit card', 'bank account', 'checking account', 'savings account',
  'routing number', 'account number', 'ssn', 'social security number', 'pin', 'password',
  'face id', 'fingerprint', 'direct deposit', 'cash card', 'digital card', 'virtual card',
  'money', 'cash', 'fund', 'balance', 'limit', 'credit limit', 'spending limit',
  'fee', 'statement', 'refund', 'bill', 'receipt', 'invoice', 'payment method',
  'ethereum', 'eth', 'bitcoin', 'btc', 'solana', 'sol', 'dogecoin', 'doge', 'crypto',
  'stock', 'share', 'fractional share', 'option', 'call option', 'put option', 'etf',
  'wallet', 'seed phrase', 'private key', 'network', 'chain',
  'phone number', 'email', 'address', 'tax document', '1099', 'w2',
  'sales navigator extension', 'extension', 'app', 'account', 'profile'
];

/**
 * Get action group for a verb
 */
export function getActionGroup(verb = '') {
  const cleaned = stemToken(cleanText(verb));
  return ACTION_TO_GROUP.get(cleaned) || null;
}

/**
 * Check if two actions are opposing/antonyms
 */
export function areActionsOpposing(actionA = '', actionB = '') {
  if (!actionA || !actionB) return false;
  const groupA = getActionGroup(actionA);
  const groupB = getActionGroup(actionB);
  if (!groupA || !groupB) return false;
  if (groupA === groupB) return false;

  for (const [g1, g2] of OPPOSING_GROUPS) {
    if ((groupA === g1 && groupB === g2) || (groupA === g2 && groupB === g1)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if two actions are synonyms (in the same group)
 */
export function areActionsSynonyms(actionA = '', actionB = '') {
  if (!actionA || !actionB) return false;
  const aClean = cleanText(actionA);
  const bClean = cleanText(actionB);
  if (aClean === bClean) return true;
  
  const groupA = getActionGroup(actionA);
  const groupB = getActionGroup(actionB);
  return Boolean(groupA && groupB && groupA === groupB);
}

/**
 * Extract platform, action, objects, modifiers, and intent from a query or title.
 */
export function extractIntent(text = '') {
  const cleaned = cleanText(text);
  if (!cleaned) {
    return {
      raw: text,
      cleaned: '',
      platform: null,
      action: null,
      actionGroup: null,
      objects: [],
      intent: 'general',
      tokens: []
    };
  }

  // 1. Detect Platform from dictionary
  let detectedPlatform = null;
  const sortedPlatforms = [...KNOWN_PLATFORMS].sort((a, b) => b.length - a.length);
  for (const p of sortedPlatforms) {
    const pRegex = new RegExp(`\\b${p.replace('.', '\\.')}\\b`, 'i');
    if (pRegex.test(cleaned)) {
      detectedPlatform = p;
      break;
    }
  }

  // Fallback: extract dynamic target entity from prepositional phrase (e.g. "in phonepe", "in airbnb")
  if (!detectedPlatform) {
    const prepMatch = cleaned
      .replace(/\b(full guide|guide|tutorial|online|step by step|easy|fast|new)\b/g, '')
      .trim()
      .match(/\b(?:in|on|to|for|from|into|at)\s+([a-z0-9]{2,}(?:\s+[a-z0-9]{2,})?)$/i);
    if (prepMatch) {
      const candidateTarget = prepMatch[1].trim();
      const genericWords = new Set([
        'iphone', 'android', 'account', 'video', 'pc', 'app', 'mobile',
        'card', 'bank', 'story', 'post', 'reel', 'photo', 'picture', 'file',
        'name', 'number', 'password', 'setting', 'device', 'channel', 'playlist'
      ]);
      if (!genericWords.has(candidateTarget) && !candidateTarget.startsWith('my ')) {
        detectedPlatform = candidateTarget;
      }
    }
  }

  // 2. Detect Action
  let detectedAction = null;
  let detectedActionGroup = null;
  
  // Look for action words in the text
  const tokens = tokenize(cleaned, false);
  for (const token of tokens) {
    const group = ACTION_TO_GROUP.get(token);
    if (group) {
      detectedAction = token;
      detectedActionGroup = group;
      break;
    }
  }

  // Special multi-word action phrases
  if (cleaned.includes('turn on') || cleaned.includes('switch on')) {
    detectedAction = 'turn on';
    detectedActionGroup = 'turn_on';
  } else if (cleaned.includes('turn off') || cleaned.includes('switch off')) {
    detectedAction = 'turn off';
    detectedActionGroup = 'turn_off';
  } else if (cleaned.includes('sign in') || cleaned.includes('log in')) {
    detectedAction = 'login';
    detectedActionGroup = 'auth_in';
  } else if (cleaned.includes('sign out') || cleaned.includes('log out')) {
    detectedAction = 'logout';
    detectedActionGroup = 'auth_out';
  } else if (cleaned.includes('cash out')) {
    detectedAction = 'cash out';
    detectedActionGroup = 'transfer_out';
  } else if (cleaned.includes('add money') || cleaned.includes('fund')) {
    // If text specifically says "add money to robinhood using debit card", 
    // note that primary intent is funding / adding money
    if (!detectedAction || detectedAction === 'add') {
      detectedAction = 'deposit';
      detectedActionGroup = 'transfer_in';
    }
  }

  // 3. Detect Objects
  const detectedObjects = [];
  const sortedObjects = [...KNOWN_OBJECTS].sort((a, b) => b.length - a.length);
  for (const obj of sortedObjects) {
    const objRegex = new RegExp(`\\b${obj}\\b`, 'i');
    if (objRegex.test(cleaned)) {
      detectedObjects.push(obj);
    }
  }

  // 4. Detect Intent Category
  let intentCategory = 'tutorial';
  if (cleaned.startsWith('how to') || cleaned.startsWith('how do i') || cleaned.includes('tutorial') || cleaned.includes('guide') || cleaned.includes('step')) {
    intentCategory = 'tutorial';
  } else if (cleaned.startsWith('can i') || cleaned.startsWith('can you') || cleaned.startsWith('does ') || cleaned.startsWith('is it possible')) {
    intentCategory = 'inquiry';
  } else if (cleaned.includes('not working') || cleaned.includes('error') || cleaned.includes('fix') || cleaned.includes('problem') || cleaned.includes('failed')) {
    intentCategory = 'troubleshoot';
  } else if (cleaned.includes('vs') || cleaned.includes('or') || cleaned.includes('difference between')) {
    intentCategory = 'comparison';
  }

  return {
    raw: text,
    cleaned,
    platform: detectedPlatform,
    action: detectedAction,
    actionGroup: detectedActionGroup,
    objects: detectedObjects,
    intent: intentCategory,
    tokens
  };
}

/**
 * Compare two sets of objects to determine compatibility.
 * Returns:
 *  1.0 for matching objects
 *  0.7 for partial overlap (e.g. 'debit card' vs 'card')
 *  0.0 for explicitly conflicting objects (e.g. 'debit card' vs 'bank account')
 */
export function compareObjects(objectsA = [], objectsB = []) {
  if (objectsA.length === 0 && objectsB.length === 0) return 1.0;
  if (objectsA.length === 0 || objectsB.length === 0) return 0.5;

  const setA = new Set(objectsA);
  const setB = new Set(objectsB);

  // Exact match
  for (const item of setA) {
    if (setB.has(item)) return 1.0;
  }

  // Conflicting payment / banking objects (e.g. card vs bank account)
  const isCardA = objectsA.some(o => o.includes('card') && !o.includes('gift card'));
  const isCardB = objectsB.some(o => o.includes('card') && !o.includes('gift card'));
  const isBankA = objectsA.some(o => o.includes('bank') || o.includes('checking') || o.includes('savings'));
  const isBankB = objectsB.some(o => o.includes('bank') || o.includes('checking') || o.includes('savings'));

  if ((isCardA && isBankB) || (isBankA && isCardB)) {
    return 0.0;
  }

  const PAYMENT_OBJECTS = ['debit card', 'credit card', 'bank account', 'checking account', 'cash card'];
  const hasPaymentA = objectsA.find(o => PAYMENT_OBJECTS.includes(o));
  const hasPaymentB = objectsB.find(o => PAYMENT_OBJECTS.includes(o));

  if (hasPaymentA && hasPaymentB && hasPaymentA !== hasPaymentB) {
    // e.g. bank account vs debit card -> conflicting!
    return 0.0;
  }

  // Conflicting crypto vs stock objects
  const CRYPTO_OBJECTS = ['eth', 'ethereum', 'btc', 'bitcoin', 'solana', 'doge', 'crypto'];
  const STOCK_OBJECTS = ['stock', 'option', 'fractional share', 'etf'];
  const hasCryptoA = objectsA.find(o => CRYPTO_OBJECTS.includes(o));
  const hasCryptoB = objectsB.find(o => CRYPTO_OBJECTS.includes(o));
  const hasStockA = objectsA.find(o => STOCK_OBJECTS.includes(o));
  const hasStockB = objectsB.find(o => STOCK_OBJECTS.includes(o));

  if ((hasCryptoA && hasStockB) || (hasStockA && hasCryptoB)) {
    return 0.0;
  }
  if (hasCryptoA && hasCryptoB && hasCryptoA !== hasCryptoB) {
    return 0.0;
  }

  // General token overlap of objects
  const tokensA = objectsA.join(' ').split(' ');
  const tokensB = objectsB.join(' ').split(' ');
  const shared = tokensA.filter(t => tokensB.includes(t));
  if (shared.length > 0) return 0.6;

  return 0.1;
}
