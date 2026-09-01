import { Component } from '@angular/core';
import { LucidePackage, LucideShieldCheck, LucideTruck } from '@lucide/angular';
import { LogoLockup } from './logo-lockup';

/**
 * Design: frame `Brand Panel` (WXmng). The navy marketing rail alongside auth
 * screens — the mobile pair uses `Mobile Brand Header` instead.
 *
 * CONTRACT: The `Panel Image` node is a remote Unsplash placeholder, so it
 * renders as a token-coloured block; do NOT hotlink it into the build.
 * `Panel Subtitle`/`Feature Label` bind to `ink-muted-on-dark`/
 * `ink-subtle-on-dark`, tokens added to close a real design-system gap — do not
 * swap them for the nearer `ink-on-dark`, which is a different colour.
 * See [[pencil-design-extraction]]
 */
@Component({
  selector: 'app-brand-panel',
  imports: [LogoLockup, LucidePackage, LucideShieldCheck, LucideTruck],
  templateUrl: './brand-panel.html',
})
export class BrandPanel {}
