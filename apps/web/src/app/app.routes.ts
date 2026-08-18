import { Routes } from '@angular/router';

// Every route lazy-loads its component so a broken screen cannot break the
// whole bundle. Overlay state (cart, account menu, notifications, toast) is
// UI layered over `/` — see DESIGN.md "Overlays are not routes" — and gets
// no entry here.
export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./features/auth/login-password').then((m) => m.LoginPasswordPage),
    title: 'Sign in — 3MRAI',
  },
  {
    path: 'login/passwordless',
    loadComponent: () =>
      import('./features/auth/login-passwordless').then((m) => m.LoginPasswordlessPage),
    title: 'Sign in with a code — 3MRAI',
  },
  {
    path: 'verify',
    loadComponent: () => import('./features/auth/verify-code').then((m) => m.VerifyCodePage),
    title: 'Verify code — 3MRAI',
  },
  {
    path: 'register',
    loadComponent: () =>
      import('./features/auth/register-password').then((m) => m.RegisterPasswordPage),
    title: 'Create account — 3MRAI',
  },
  {
    path: 'register/passwordless',
    loadComponent: () =>
      import('./features/auth/register-passwordless').then((m) => m.RegisterPasswordlessPage),
    title: 'Create account — 3MRAI',
  },
  {
    path: 'password/new',
    loadComponent: () =>
      import('./features/auth/set-new-password').then((m) => m.SetNewPasswordPage),
    title: 'Set new password — 3MRAI',
  },
  {
    path: '',
    loadComponent: () => import('./features/catalogue/home').then((m) => m.HomePage),
    title: '3MRAI',
    pathMatch: 'full',
  },
  {
    path: 'checkout',
    loadComponent: () =>
      import('./features/checkout/checkout-payment').then((m) => m.CheckoutPaymentPage),
    title: 'Checkout — 3MRAI',
  },
  {
    path: 'orders',
    loadComponent: () => import('./features/orders/orders-list').then((m) => m.OrdersListPage),
    title: 'Your orders — 3MRAI',
  },
  {
    path: 'orders/:orderId',
    loadComponent: () => import('./features/orders/order-detail').then((m) => m.OrderDetailPage),
    title: 'Order detail — 3MRAI',
  },
  {
    path: 'profile',
    loadComponent: () => import('./features/account/profile').then((m) => m.ProfilePage),
    title: 'Your profile — 3MRAI',
  },
  { path: '**', redirectTo: '' },
];
