import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { diskStorage } from "multer";
import path from "path";
import fs from "fs";
import { AdTemplateService } from "./ad-template.service";
import { Tenant } from "../common/decorators/tenant.decorator";
import type { CreateAdTemplateDto, UpdateAdTemplateDto } from "@cs-ai/shared-types";

/** Prefix: /api/ad-templates/* — halaman Auto Bales Iklan */
@Controller("ad-templates")
export class AdTemplateController {
  constructor(private readonly ads: AdTemplateService) {}

  @Get()
  list(@Tenant("tenantId") tenantId: string) {
    return this.ads.list(tenantId);
  }

  @Post()
  create(@Tenant("tenantId") tenantId: string, @Body() dto: CreateAdTemplateDto) {
    return this.ads.create(tenantId, dto);
  }

  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const uploadPath = path.resolve(process.cwd(), "uploads", "ad-media");
          if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
          cb(null, uploadPath);
        },
        filename: (_req, file, cb) => {
          const ext = path.extname(file.originalname);
          const uniqueName = `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
          cb(null, uniqueName);
        },
      }),
      limits: { fileSize: 50 * 1024 * 1024 }, // 50MB for video/image
    }),
  )
  uploadMedia(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("File media wajib diunggah");
    const isVideo = file.mimetype.startsWith("video/") || Boolean(file.originalname.match(/\.(mp4|3gp|mov|webm)$/i));
    return {
      url: `/uploads/ad-media/${file.filename}`,
      filename: file.originalname,
      storedName: file.filename,
      size: file.size,
      mimetype: file.mimetype,
      tipe: isVideo ? "video" : "gambar",
    };
  }

  @Put(":id")
  update(
    @Tenant("tenantId") tenantId: string,
    @Param("id") id: string,
    @Body() dto: UpdateAdTemplateDto,
  ) {
    return this.ads.update(tenantId, id, dto);
  }

  @Delete(":id")
  remove(@Tenant("tenantId") tenantId: string, @Param("id") id: string) {
    return this.ads.remove(tenantId, id);
  }
}
