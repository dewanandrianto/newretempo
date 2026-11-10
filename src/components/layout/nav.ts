import {
  AlertOctagon,
  ArrowLeftRight,
  Boxes,
  Code2,
  CreditCard,
  FileText,
  Landmark,
  LayoutDashboard,
  Layers,
  Repeat,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
}

export interface NavGroup {
  label: string
  items: NavItem[]
}

export const dashboardNav: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      { to: '/app', label: 'Overview', icon: LayoutDashboard, end: true },
      { to: '/app/products', label: 'Products', icon: Boxes },
      { to: '/app/plans', label: 'Subscription Plans', icon: Layers },
      { to: '/app/customers', label: 'Customers', icon: Users },
      { to: '/app/subscriptions', label: 'Subscriptions', icon: Repeat },
    ],
  },
  {
    label: 'Money',
    items: [
      { to: '/app/invoices', label: 'Invoices', icon: FileText },
      { to: '/app/payments', label: 'Payments', icon: CreditCard },
      { to: '/app/escrow', label: 'Escrow', icon: Landmark },
      { to: '/app/transactions', label: 'Transactions', icon: ArrowLeftRight },
      { to: '/app/disputes', label: 'Disputes', icon: AlertOctagon },
    ],
  },
  {
    label: 'Build',
    items: [
      { to: '/app/developers', label: 'Developers', icon: Code2 },
      { to: '/app/settings', label: 'Settings', icon: Settings },
    ],
  },
]

export const allNavItems = dashboardNav.flatMap((g) => g.items)
