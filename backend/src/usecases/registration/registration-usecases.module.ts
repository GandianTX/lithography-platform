// src/usecases/registration/registration-usecases.module.ts
import { LithographyModule } from '@modules/lithography/lithography.module';
import { AccountInstallerModule } from '@modules/account/account-installer.module';
import { PasswordModule } from '@modules/common/password/password.module';
import { ThirdPartyAuthModule } from '@modules/third-party-auth/third-party-auth.module';
import { Module } from '@nestjs/common';
import { VerificationRecordModule } from '@src/modules/verification-record/verification-record.module';
import { GetEngineerRegistrationStatusUsecase } from '@src/usecases/registration/get-engineer-registration-status.usecase';
import { ListRegistrationOrganizationsUsecase } from '@src/usecases/registration/list-registration-organizations.usecase';
import { RegisterWithEmailUsecase } from '@src/usecases/registration/register-with-email.usecase';
import { RegisterWithThirdPartyUsecase } from '@src/usecases/registration/register-with-third-party.usecase';
import { ResubmitEngineerRegistrationUsecase } from '@src/usecases/registration/resubmit-engineer-registration.usecase';
import { WeappRegisterUsecase } from '@src/usecases/registration/weapp-register.usecase';
import { GetAdminEngineerRegistrationDetailUsecase } from '@src/usecases/registration/get-admin-engineer-registration-detail.usecase';
import { ListAdminEngineerRegistrationsUsecase } from '@src/usecases/registration/list-admin-engineer-registrations.usecase';
import { ReviewEngineerRegistrationUsecase } from '@src/usecases/registration/review-engineer-registration.usecase';

@Module({
  imports: [
    VerificationRecordModule,
    AccountInstallerModule,
    PasswordModule,
    ThirdPartyAuthModule,
    LithographyModule,
  ],
  providers: [
    RegisterWithEmailUsecase,
    RegisterWithThirdPartyUsecase,
    WeappRegisterUsecase,
    ListRegistrationOrganizationsUsecase,
    GetEngineerRegistrationStatusUsecase,
    ResubmitEngineerRegistrationUsecase,
    ListAdminEngineerRegistrationsUsecase,
    GetAdminEngineerRegistrationDetailUsecase,
    ReviewEngineerRegistrationUsecase,
  ],
  exports: [
    RegisterWithEmailUsecase,
    RegisterWithThirdPartyUsecase,
    WeappRegisterUsecase,
    ListRegistrationOrganizationsUsecase,
    GetEngineerRegistrationStatusUsecase,
    ResubmitEngineerRegistrationUsecase,
    ListAdminEngineerRegistrationsUsecase,
    GetAdminEngineerRegistrationDetailUsecase,
    ReviewEngineerRegistrationUsecase,
  ],
})
export class RegistrationUsecasesModule {}
