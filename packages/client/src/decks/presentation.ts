import type { DeckValidationResponse, ServiceCatalog } from '@ptcg/protocol';

/** 校验结果的界面呈现：三个色调对应“可对战 / 规则合法但未就绪 / 不合法”。 */

export type ValidationTone = 'ok' | 'warn' | 'danger';

export interface ValidationSummary {
  readonly tone: ValidationTone;
  readonly label: string;
}

export function validationSummary(validation: DeckValidationResponse): ValidationSummary {
  if (!validation.legal) {
    const count = validation.problems.filter((problem) => problem.kind === 'legality').length;
    return { tone: 'danger', label: `规则不合法（${count} 项问题）` };
  }
  if (!validation.ready) {
    const unsupported = validation.problems.find((problem) => problem.code === 'effect-unsupported');
    if (unsupported !== undefined) {
      return { tone: 'warn', label: '规则合法 · 效果未接入，正式对战未就绪' };
    }
    return { tone: 'warn', label: '规则合法 · 尚不能正式对战' };
  }
  return { tone: 'ok', label: '可以正式对战' };
}

/** 显示用短版本：完整哈希太长，界面只展示前 12 位并保留复制价值。 */
export function shortRevision(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

export function catalogRevisionLabel(catalog: ServiceCatalog): string {
  return `环境 ${catalog.content.environment.id} · 目录版本 ${shortRevision(catalog.catalogVersion)} · 资料修订 ${shortRevision(catalog.content.dataRevision.sourceDigest)}`;
}
