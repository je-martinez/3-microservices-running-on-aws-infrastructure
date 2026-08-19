import { Component } from '@angular/core';
import { LucidePackage, LucideShieldCheck, LucideTruck } from '@lucide/angular';
import { LogoLockup } from './logo-lockup';

/**
 * Design: frame `Brand Panel` (WXmng). The navy marketing rail alongside
 * auth screens (login/register/verify/forgot-password), fixed 560x1024 in
 * the desktop frame — the mobile pair instead uses `Mobile Brand Header`.
 *
 * The `Panel Image` node is a remote Unsplash placeholder
 * (images.unsplash.com/photo-1632463593837-...), not a repo asset or final
 * artwork — per DESIGN.md's Assets table this renders as a token-coloured
 * placeholder rather than a hotlinked production image.
 *
 * `Panel Subtitle`/`Feature Label` originally had no matching token
 * (#A9B2C0/#C7CDD8 vs. the closest existing `ink-on-dark` at #E8EAEE) —
 * `ink-muted-on-dark`/`ink-subtle-on-dark` were added to styles.css to
 * close that gap, so both now bind to real tokens, not a substitution.
 */
@Component({
  selector: 'app-brand-panel',
  imports: [LogoLockup, LucidePackage, LucideShieldCheck, LucideTruck],
  templateUrl: './brand-panel.html',
})
export class BrandPanel {}
