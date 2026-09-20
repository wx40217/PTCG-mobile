/**
 * 训练家端到端隐私断言的公开身份 oracle（T10 / #11）。
 *
 * 判定「候选卡身份是否泄露给对手」时必须使用动作（出牌训练家）前冻结的合法
 * 公开身份集合：
 *   - 冻结集合来自接收方当时已收到的公开区域（双方战斗/备战/弃牌、附着能量、
 *     共同竞技场）与公开事件；
 *   - 接收方自己的手牌/牌库/奖赏/个人待决候选等私人区域永远不进入冻结集合；
 *   - 动作后新收到的载荷只作为「是否出现候选身份」的证据，不能反过来推导
 *     公开身份。否则，实现若把候选身份塞进一个新事件，该事件自身携带的
 *     cardId 会把泄露身份洗白成「已公开」，断言出现假阴性。
 *
 * 用法：出牌前 `const frozen = publicIdsFor(b); const from = rawB.length;`
 * 待决阶段用 `evaluateCandidatePrivacy({ candidateIds, frozenPublicIds: frozen,
 * payloads: rawB.slice(from) })` 取得 `leaked`（动作前仍隐藏却出现的身份）。
 */

/** JSON 载荷中的卡牌实例身份；带引号匹配，避免 `...-1` 误命中 `...-12`。 */
export function payloadHasCardId(raw, cardId) {
  return raw.includes(`"${cardId}"`);
}

/**
 * 从接收方实际收到的对局视图推导「已依法公开的卡牌身份」：
 * 公开区域（双方战斗/备战/弃牌、附着能量与共同竞技场）以及全部公开事件。
 * 接收方自己的手牌/牌库/奖赏和个人待决候选不在其中；因此集合里的身份都有
 * 合法的载荷来源，可用来区分「更早公开过的同一身份」与「私人信息泄露」。
 */
export function collectPublicCardIds(views) {
  const ids = new Set();
  const addCard = (card) => {
    if (card !== null && card !== undefined && typeof card.cardId === 'string') {
      ids.add(card.cardId);
    }
  };
  const addPokemon = (pokemon) => {
    if (pokemon === null || pokemon === undefined) {
      return;
    }
    addCard(pokemon.card);
    for (const energy of pokemon.energies ?? []) {
      addCard(energy.card);
    }
  };
  const addSide = (side) => {
    if (side === null || side === undefined) {
      return;
    }
    for (const card of side.discard ?? []) {
      addCard(card);
    }
    addPokemon(side.active);
    for (const pokemon of side.bench ?? []) {
      addPokemon(pokemon);
    }
  };
  const addValue = (value) => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        addValue(entry);
      }
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'cardId' && typeof entry === 'string') {
        ids.add(entry);
      } else {
        addValue(entry);
      }
    }
  };
  for (const view of views) {
    if (view === null || view === undefined) {
      continue;
    }
    addSide(view.you);
    addSide(view.opponent);
    addCard(view.stadium);
    addValue(view.events);
  }
  return ids;
}

/** 接收方已收到的公开身份集合；必须在触发动作之前调用并冻结结果。 */
export function publicIdsFor(client) {
  return collectPublicCardIds(client.messages.filter((message) => message.type === 'match').map((message) => message.view));
}

/**
 * 用动作前冻结的公开身份集合判定候选身份：
 *   - `stillHidden`：动作前未合法公开，任何新载荷出现都算泄露；
 *   - `previouslyPublic`：动作前已合法公开，允许在载荷中出现；
 *   - `leaked`：仍隐藏却出现在给定载荷中的身份（断言应失败）；
 *   - `reappearedPublic`：本就公开的同一身份在载荷中再次出现（仅信息输出）。
 */
export function evaluateCandidatePrivacy({ candidateIds, frozenPublicIds, payloads }) {
  const stillHidden = [];
  const previouslyPublic = [];
  for (const cardId of candidateIds) {
    if (frozenPublicIds.has(cardId)) {
      previouslyPublic.push(cardId);
    } else {
      stillHidden.push(cardId);
    }
  }
  const appearsIn = (cardId) => payloads.some((raw) => payloadHasCardId(raw, cardId));
  return {
    stillHidden,
    previouslyPublic,
    leaked: stillHidden.filter((cardId) => appearsIn(cardId)),
    reappearedPublic: previouslyPublic.filter((cardId) => appearsIn(cardId)),
  };
}
