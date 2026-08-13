/**
 * Readiness-only AskUser. Pipeline runs keep auto-answering via
 * `droid/permissions.ts`; this module parks questions for a real UI.
 */

import { randomBytes } from 'node:crypto';
import type {
  ReadinessAskAnswer,
  ReadinessAskQuestion,
  ReadinessPendingAsk,
} from '@shared/types.js';

export function parseAskUserQuestions(params: Record<string, unknown>): ReadinessAskQuestion[] {
  const raw = Array.isArray(params.questions) ? params.questions : [];
  if (!raw.length) {
    const fallback =
      typeof params.question === 'string' && params.question.trim() ? params.question.trim() : '';
    return [{ index: 0, question: fallback, options: [] }];
  }
  return raw.map((item, i) => {
    const q = (item ?? {}) as Record<string, unknown>;
    const options = Array.isArray(q.options)
      ? q.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
      : [];
    return {
      index: typeof q.index === 'number' ? q.index : i,
      question: typeof q.question === 'string' ? q.question : '',
      options,
    };
  });
}

export function parkAskUser(params: Record<string, unknown>): ReadinessPendingAsk {
  return {
    askId: `ask_${randomBytes(6).toString('hex')}`,
    questions: parseAskUserQuestions(params),
  };
}

/**
 * Map the operator's answers onto the CLI's `{index, question, answer}` shape.
 * Missing answers stay empty so the session can refuse to resume rather than
 * invent a first-option default — that invention is the pipeline policy.
 */
export function answersFromUser(
  questions: ReadinessAskQuestion[],
  answers: ReadinessAskAnswer[],
): { index: number; question: string; answer: string }[] {
  const byIndex = new Map(answers.map((a) => [a.index, a.answer]));
  return questions.map((q) => ({
    index: q.index,
    question: q.question,
    answer: (byIndex.get(q.index) ?? '').trim(),
  }));
}

export function answersComplete(
  questions: ReadinessAskQuestion[],
  answers: ReadinessAskAnswer[],
): boolean {
  return answersFromUser(questions, answers).every((a) => a.answer.length > 0);
}
