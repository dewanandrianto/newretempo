import { useParams } from 'react-router-dom'
import { CapabilityCheckout } from './CheckoutPage'
/** Invoice links are expiring capabilities, never private invoice UUID lookups. */
export default function InvoicePage(){const {invoiceId=''}=useParams();return <CapabilityCheckout token={invoiceId} invoice />}
