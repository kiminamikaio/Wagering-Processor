import { Controller, Get } from "@nestjs/common";

@Controller("health")
export class HealthController {
  @Get("live")
  getLive(): { status: "ok" } {
    return { status: "ok" };
  }
}
