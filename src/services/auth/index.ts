import { apiAuthService } from './apiAuthService'
import type { AuthService } from './types'

export const auth: AuthService = apiAuthService

export type { AuthService } from './types'
