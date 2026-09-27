import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";

import configuration from "./config/configuration";
import { CommonModule } from "./common/common.module";

import { AuthModule } from "./auth/auth.module";
import { AdminModule } from "./admin/admin.module";
import { KnowledgeModule } from "./knowledge/knowledge.module";
import { BotModule } from "./bot/bot.module";
import { WhatsappModule } from "./whatsapp/whatsapp.module";
import { ChatModule } from "./chat/chat.module";
import { AdTemplateModule } from "./ad-templates/ad-template.module";
import { AnalyticsModule } from "./analytics/analytics.module";
import { LicenseModule } from "./license/license.module";
import { InternalModule } from "./internal/internal.module";
import { TenantModule } from "./tenant/tenant.module";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", "../../.env", "../.env"],
      load: [configuration],
    }),
    CommonModule,
    AuthModule,
    AdminModule,
    KnowledgeModule,
    BotModule,
    WhatsappModule,
    ChatModule,
    AdTemplateModule,
    AnalyticsModule,
    LicenseModule,
    InternalModule,
    TenantModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
