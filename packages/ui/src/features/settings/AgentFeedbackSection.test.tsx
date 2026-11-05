import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderWithHost, resetStores } from '../../test/utils';
import { AgentFeedbackSection } from './AgentFeedbackSection';
import { AGENT_FEEDBACK_EMAIL_STORAGE_KEY, writeAgentFeedbackEmail } from './agentFeedback';

/** Types `text` one character at a time (each keystroke re-renders the section). */
function typeChars(el: HTMLElement, text: string): void {
  let value = (el as HTMLInputElement | HTMLTextAreaElement).value;
  for (const ch of text) {
    value += ch;
    fireEvent.change(el, { target: { value } });
    // Regression (v0.1.34): every keystroke used to yank focus back to the email box.
    expect(document.activeElement).toBe(el);
  }
}

function openDialog(): HTMLElement {
  fireEvent.click(screen.getByTestId('open-agent-feedback-btn'));
  return screen.getByTestId('agent-feedback-dialog');
}

describe('AgentFeedbackSection focus', () => {
  beforeEach(() => {
    resetStores();
    localStorage.removeItem(AGENT_FEEDBACK_EMAIL_STORAGE_KEY);
  });
  afterEach(() => {
    cleanup();
    localStorage.removeItem(AGENT_FEEDBACK_EMAIL_STORAGE_KEY);
  });

  it('without a saved email: opens on the email box, then keeps focus on 标题 / 问题描述 while typing', () => {
    renderWithHost(<AgentFeedbackSection />);
    const dialog = openDialog();
    const email = within(dialog).getByTestId('agent-feedback-email-input');
    const summary = within(dialog).getByTestId('agent-feedback-summary-input');
    const details = within(dialog).getByTestId('agent-feedback-details-input');
    expect(document.activeElement).toBe(email);
    expect(summary).not.toHaveAttribute('data-autofocus');

    typeChars(email, 'me@example.com');
    expect(email).toHaveValue('me@example.com');

    act(() => summary.focus());
    typeChars(summary, '输入框跳焦点');
    expect(summary).toHaveValue('输入框跳焦点');
    expect(document.activeElement).toBe(summary);

    act(() => details.focus());
    typeChars(details, '输入文字会自动跳到邮箱输入框');
    expect(details).toHaveValue('输入文字会自动跳到邮箱输入框');
    expect(document.activeElement).toBe(details);
    expect(email).toHaveValue('me@example.com');
  });

  it('with a saved valid email: opens on 标题 and keeps focus on each edited field', () => {
    writeAgentFeedbackEmail('agent@example.com');
    renderWithHost(<AgentFeedbackSection />);
    const dialog = openDialog();
    const email = within(dialog).getByTestId('agent-feedback-email-input');
    const summary = within(dialog).getByTestId('agent-feedback-summary-input');
    const details = within(dialog).getByTestId('agent-feedback-details-input');
    expect(email).toHaveValue('agent@example.com');
    expect(summary).toHaveAttribute('data-autofocus', 'true');
    expect(document.activeElement).toBe(summary);

    typeChars(summary, '左右滑动切换tab');
    act(() => details.focus());
    typeChars(details, 'abc\n第二行');
    expect(document.activeElement).toBe(details);
    expect(summary).toHaveValue('左右滑动切换tab');
    expect(details).toHaveValue('abc\n第二行');

    // Editing the saved email still works without focus jumping away from it.
    act(() => email.focus());
    typeChars(email, '.cn');
    expect(email).toHaveValue('agent@example.com.cn');
  });

  it('re-evaluates initial focus on each open (cleared email → email box)', () => {
    writeAgentFeedbackEmail('agent@example.com');
    renderWithHost(<AgentFeedbackSection />);
    let dialog = openDialog();
    expect(document.activeElement).toBe(within(dialog).getByTestId('agent-feedback-summary-input'));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('agent-feedback-dialog')).toBeNull();

    writeAgentFeedbackEmail('');
    dialog = openDialog();
    expect(document.activeElement).toBe(within(dialog).getByTestId('agent-feedback-email-input'));
    expect(within(dialog).getByTestId('agent-feedback-summary-input')).not.toHaveAttribute('data-autofocus');
  });
});
