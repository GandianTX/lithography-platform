// src/usecases/auth/auth-usecases.module.ts
import { AuthModule } from '@modules/auth/auth.module';
import { ThirdPartyAuthModule } from '@modules/third-party-auth/third-party-auth.module';
import { LithographyModule } from '@src/modules/lithography/lithography.module';
import { Module } from '@nestjs/common';
import { AccountInstallerModule } from '@src/modules/account/account-installer.module';
import { DecideLoginRoleUsecase } from '@src/usecases/auth/decide-login-role.usecase';
import { EnrichLoginWithIdentityUsecase } from '@src/usecases/auth/enrich-login-with-identity.usecase';
import { ExecuteLoginFlowUsecase } from '@src/usecases/auth/execute-login-flow.usecase';
import { LoginByAccountIdUsecase } from '@src/usecases/auth/login-by-account-id.usecase';
import { LoginWithPasswordUsecase } from '@src/usecases/auth/login-with-password.usecase';
import { LoginWithThirdPartyUsecase } from '@src/usecases/auth/login-with-third-party.usecase';
import { ResolveSessionRestrictionUsecase } from '@src/usecases/auth/resolve-session-restriction.usecase';
import { ResolveWebSessionUsecase } from '@src/usecases/auth/resolve-web-session.usecase';
import { ValidateAccessTokenSessionUsecase } from '@src/usecases/auth/validate-access-token-session.usecase';

@Module({
  imports: [AuthModule, ThirdPartyAuthModule, AccountInstallerModule, LithographyModule],
  providers: [
    LoginWithPasswordUsecase,
    ExecuteLoginFlowUsecase,
    LoginByAccountIdUsecase,
    LoginWithThirdPartyUsecase,
    DecideLoginRoleUsecase,
    EnrichLoginWithIdentityUsecase,
    ResolveSessionRestrictionUsecase,
    ValidateAccessTokenSessionUsecase,
    ResolveWebSessionUsecase,
  ],
  exports: [
    LoginWithPasswordUsecase,
    ExecuteLoginFlowUsecase,
    LoginByAccountIdUsecase,
    LoginWithThirdPartyUsecase,
    DecideLoginRoleUsecase,
    EnrichLoginWithIdentityUsecase,
    ResolveSessionRestrictionUsecase,
    ValidateAccessTokenSessionUsecase,
    ResolveWebSessionUsecase,
  ],
})
export class AuthUsecasesModule {}
