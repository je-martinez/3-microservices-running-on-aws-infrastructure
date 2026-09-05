import { HttpTestingController, TestRequest } from '@angular/common/http/testing';
import { Provider } from '@angular/core';
import { ComponentFixture } from '@angular/core/testing';
import { IDBFactory } from 'fake-indexeddb';
import {
  LucideArrowLeft,
  LucideArrowRight,
  LucideCheck,
  LucideEyeOff,
  LucideInfo,
  LucideLock,
  LucideLockKeyhole,
  LucideMail,
  LucideShieldAlert,
  LucideShieldCheck,
  LucideTimer,
  LucideUser,
  LucideWandSparkles,
  provideLucideIcons,
} from '@lucide/angular';

import { User } from '../../core/api/types';

/**
 * WHY: LucideDynamicIcon resolves an icon by NAME from the registry, so an
 * unregistered one throws at render — the auth screens render before a single
 * assertion runs. This mirrors the subset app.config.ts registers for them.
 */
export const AUTH_TEST_PROVIDERS: Provider[] = [
  provideLucideIcons(
    LucideArrowLeft,
    LucideArrowRight,
    LucideCheck,
    LucideEyeOff,
    LucideInfo,
    LucideLock,
    LucideLockKeyhole,
    LucideMail,
    LucideShieldAlert,
    LucideShieldCheck,
    LucideTimer,
    LucideUser,
    LucideWandSparkles,
  ),
];

/**
 * Swaps in a pristine IndexedDB.
 *
 * CONTRACT: Call per test, not per file. fake-indexeddb keeps ONE database for
 * the whole run, so a "401 persists nothing" assertion reads the PREVIOUS
 * test's tokens and fails while the code under test is correct.
 * See [[2026-09-04-angular-http-testing-traps]]
 */
export function resetStorage(): void {
  globalThis.indexedDB = new IDBFactory();
}

/** A complete User, since the type requires all fifteen keys. */
export const USER: User = {
  id: 'usr_V1StGXR8Z5',
  email: 'jane@example.com',
  fullName: 'Jane Doe',
  address: null,
  phoneNumber: null,
  tags: [],
  authType: 'PASSWORD',
  mustChangePassword: false,
  createdBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedBy: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedBy: null,
  deletedAt: null,
  isDeleted: false,
};

/** Types into the `app-field` whose label matches, the way a user would. */
export function fillField(fixture: ComponentFixture<unknown>, label: string, value: string): void {
  const root = fixture.nativeElement as HTMLElement;
  const field = Array.from(root.querySelectorAll('app-field')).find((element) =>
    element.querySelector('span')?.textContent?.trim().startsWith(label),
  );
  if (!field) throw new Error(`No app-field labelled "${label}"`);
  const input = field.querySelector('input');
  if (!input) throw new Error(`Field "${label}" renders no input`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

/** Types into a plain `<input>` matched by its aria-label. */
export function fillInput(
  fixture: ComponentFixture<unknown>,
  ariaLabel: string,
  value: string,
): void {
  const root = fixture.nativeElement as HTMLElement;
  const input = root.querySelector<HTMLInputElement>(`input[aria-label="${ariaLabel}"]`);
  if (!input) throw new Error(`No input labelled "${ariaLabel}"`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
}

/**
 * WHY: submit the FORM, not the primary button — ButtonPrimary renders
 * `type="button"`, so clicking it never fires a native submit and a test built
 * on the click would exercise a path the keyboard user does not take. Both
 * routes call the same handler.
 */
export function submitForm(fixture: ComponentFixture<unknown>): void {
  const form = (fixture.nativeElement as HTMLElement).querySelector('form');
  if (!form) throw new Error('Component renders no form');
  form.dispatchEvent(new Event('submit'));
  fixture.detectChanges();
}

/** One macrotask turn plus a change-detection pass. */
async function pump(fixture: ComponentFixture<unknown>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await fixture.whenStable();
  fixture.detectChanges();
}

const MAX_TURNS = 25;

/**
 * Drains pending async work and re-renders.
 *
 * CONTRACT: `whenStable()` alone is NOT enough through TokenStore — its
 * IndexedDB round trip settles on the MACROTASK queue (measured: 4 turns per
 * write), which `whenStable()` never pumps. The symptom is the follow-up
 * GET /users/me reported as "found none", i.e. unfinished read as missing.
 * See [[2026-09-04-angular-http-testing-traps]]
 */
export async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await pump(fixture);
}

/**
 * Pumps until the testing backend holds a request for `url`, then returns it.
 *
 * CONTRACT: `match()` CONSUMES what it returns (verified: a second call for the
 * same URL answers 0), so the loop hands the request back itself. Polling with
 * `match()` then reading via `expectOne()` throws "found none" on the very
 * request just located.
 * See [[2026-09-04-angular-http-testing-traps]]
 */
export async function awaitRequest(
  fixture: ComponentFixture<unknown>,
  controller: HttpTestingController,
  url: string,
): Promise<TestRequest> {
  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const [request] = controller.match(url);
    if (request) return request;
    await pump(fixture);
  }
  throw new Error(`No request for ${url} within ${MAX_TURNS} turns`);
}

/** Trimmed text of the first match, or '' when nothing matches. */
export function textOf(fixture: ComponentFixture<unknown>, selector: string): string {
  const element = (fixture.nativeElement as HTMLElement).querySelector(selector);
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}
