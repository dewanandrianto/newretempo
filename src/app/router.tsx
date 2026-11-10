import { lazy } from 'react'
import { Route, Routes } from 'react-router-dom'
import { PublicLayout } from '@/components/layout/PublicLayout'
import LandingPage from '@/features/landing/LandingPage'
import NotFoundPage from './NotFoundPage'
import { RouteBoundary } from './RouteBoundary'

const DashboardLayout = lazy(() => import('@/components/layout/DashboardLayout').then(module => ({ default: module.DashboardLayout })))
const LoginPage = lazy(() => import('@/features/auth/LoginPage'))
const SignUpPage = lazy(() => import('@/features/auth/SignUpPage'))
const OnboardingPage = lazy(() => import('@/features/auth/OnboardingPage'))
const ForgotPasswordPage = lazy(() => import('@/features/auth/AccountPages').then(module => ({ default: module.ForgotPasswordPage })))
const ResetPasswordPage = lazy(() => import('@/features/auth/AccountPages').then(module => ({ default: module.ResetPasswordPage })))
const VerifyEmailPage = lazy(() => import('@/features/auth/AccountPages').then(module => ({ default: module.VerifyEmailPage })))
const OverviewPage = lazy(() => import('@/features/dashboard/pages/OverviewPage'))
const PlansPage = lazy(() => import('@/features/dashboard/pages/CatalogPages').then(module => ({ default: module.PlansPage })))
const ProductsPage = lazy(() => import('@/features/dashboard/pages/CatalogPages').then(module => ({ default: module.ProductsPage })))
const CustomersPage = lazy(() => import('@/features/dashboard/pages/CustomerPages').then(module => ({ default: module.CustomersPage })))
const SubscriptionsPage = lazy(() => import('@/features/dashboard/pages/CustomerPages').then(module => ({ default: module.SubscriptionsPage })))
const DisputesPage = lazy(() => import('@/features/dashboard/pages/MoneyPages').then(module => ({ default: module.DisputesPage })))
const InvoicesPage = lazy(() => import('@/features/dashboard/pages/MoneyPages').then(module => ({ default: module.InvoicesPage })))
const PaymentsPage = lazy(() => import('@/features/dashboard/pages/MoneyPages').then(module => ({ default: module.PaymentsPage })))
const TransactionsPage = lazy(() => import('@/features/dashboard/pages/MoneyPages').then(module => ({ default: module.TransactionsPage })))
const EscrowPage = lazy(() => import('@/features/dashboard/pages/EscrowPage'))
const DevelopersPage = lazy(() => import('@/features/dashboard/pages/DevelopersPage'))
const SettingsPage = lazy(() => import('@/features/dashboard/pages/SettingsPage'))
const CustomerLayout = lazy(() => import('@/features/customer/CustomerLayout').then(module => ({ default: module.CustomerLayout })))
const CheckoutPage = lazy(() => import('@/features/customer/CheckoutPage'))
const PortalPage = lazy(() => import('@/features/customer/PortalPage'))
const InvoicePage = lazy(() => import('@/features/customer/InvoicePage'))
const WalletRoutes = lazy(() => import('./providers/WalletRoutes'))

export function AppRoutes() {
  return (
    <RouteBoundary>
      <Routes>
        <Route element={<PublicLayout />}>
          <Route index element={<LandingPage />} />
        </Route>

        <Route element={<WalletRoutes />}>
          <Route path="login" element={<LoginPage />} />
          <Route path="signup" element={<SignUpPage />} />
          <Route path="onboarding" element={<OnboardingPage />} />
          <Route path="forgot-password" element={<ForgotPasswordPage />} />
          <Route path="reset-password" element={<ResetPasswordPage />} />
          <Route path="verify-email" element={<VerifyEmailPage />} />

          <Route path="app" element={<DashboardLayout />}>
            <Route index element={<OverviewPage />} />
            <Route path="products" element={<ProductsPage />} />
            <Route path="plans" element={<PlansPage />} />
            <Route path="customers" element={<CustomersPage />} />
            <Route path="subscriptions" element={<SubscriptionsPage />} />
            <Route path="invoices" element={<InvoicesPage />} />
            <Route path="payments" element={<PaymentsPage />} />
            <Route path="escrow" element={<EscrowPage />} />
            <Route path="transactions" element={<TransactionsPage />} />
            <Route path="disputes" element={<DisputesPage />} />
            <Route path="developers" element={<DevelopersPage />} />
            <Route path="settings" element={<SettingsPage />} />
          </Route>

          <Route element={<CustomerLayout />}>
            <Route path="pay/:sessionId" element={<CheckoutPage />} />
            <Route path="checkout/:sessionId" element={<CheckoutPage />} />
            <Route path="portal" element={<PortalPage />} />
            <Route path="invoice/:invoiceId" element={<InvoicePage />} />
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </RouteBoundary>
  )
}
