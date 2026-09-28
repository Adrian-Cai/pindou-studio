import type { IncomingMessage, ServerResponse } from "node:http";
import {
  decryptPushBody,
  extractPushCiphertext,
  verifyPushRequest,
  verifyPushSignature,
} from "../modules/payments/virtual-pay-push";
import { getLegalDocument } from "../modules/legal/legal-document-service";
import { validatePersistedPattern } from "../modules/works/pattern";
import { aiPublicFailure, aiPublicHttpStatus } from "../modules/ai/error-contract";
import { AppError, invalidArgument, unauthorized } from "../shared/app-error";
import { parseBearerToken } from "../modules/auth/authenticator";
import { readJsonObject, readRawBody, readRawJsonObject, readSingleUploadedFile } from "./request-body";
import {
  idempotencyKey,
  validateContentSecurityTextBody,
  validateCreateAiGenerationBody,
  validateCreatePaymentBody,
  validateDownloadBody,
  validateFavoriteBody,
  validateLoginBody,
  validateNicknameBody,
  validatePrivacyPatch,
  validateWorkBody,
  validateWorkUpdateBody,
} from "./request-validation";
import {
  DELIVERY_EVENT,
  IOS_REFUND_QUERY_EVENT,
  REFUND_EVENT,
  aiGenerationId,
  downloadListOptions,
  errorPayload,
  favoriteListOptions,
  favoriteWorkId,
  hasRequestBody,
  listOptions,
  orderListOptions,
  parseDeliveryNotification,
  parseEventName,
  parseIosRefundQuery,
  parseRefundNotification,
  paymentOrderAction,
  positiveQueryInteger,
  requestId,
  requireContentSecurity,
  sendImage,
  sendJson,
  sendNoContent,
  sendRaw,
  sendText,
  wechatPaymentHeaders,
  workId,
} from "./app-helpers";
import type { HttpApplication, HttpApplicationDependencies } from "./app-helpers";
export type { HttpApplication, HttpApplicationDependencies } from "./app-helpers";

const SERVICE_NAME = "pindou-studio-server";

export function createHttpApplication(dependencies: HttpApplicationDependencies): HttpApplication {
  return (request, response) => {
    const id = requestId();
    response.setHeader("x-request-id", id);

    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/health") {
        try {
          const databaseHealth = await dependencies.database.check();
          sendJson(response, 200, {
            status: "ok",
            service: SERVICE_NAME,
            timestamp: new Date().toISOString(),
            database: databaseHealth,
            capabilities: dependencies.capabilities ?? {
              wechatPay: false,
              aiGeneration: false,
              persistentStorage: false,
              httpsPublicUrls: false,
              monitoringAlerts: false,
            },
          });
        } catch {
          sendJson(response, 503, {
            status: "degraded",
            service: SERVICE_NAME,
            timestamp: new Date().toISOString(),
            database: { status: "down" },
          });
        }
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/media/avatars/")) {
        if (url.searchParams.size > 0) throw invalidArgument("头像地址不接受查询参数");
        const avatar = await dependencies.avatars.read(url.pathname);
        if (avatar) {
          sendImage(response, avatar);
          return;
        }
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/media/covers/")) {
        if (url.searchParams.size > 0) throw invalidArgument("封面地址不接受查询参数");
        const cover = await dependencies.covers.read(url.pathname);
        if (cover) {
          sendImage(response, cover);
          return;
        }
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJsonObject(request);
        const result = await dependencies.auth.login(validateLoginBody(body));
        sendJson(response, 200, result);
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/auth/session") {
        if (url.searchParams.size > 0) throw invalidArgument("登出接口不接受查询参数");
        if (hasRequestBody(request)) throw invalidArgument("登出接口不接受请求体");
        await dependencies.authenticator.authenticate(request.headers.authorization);
        const token = parseBearerToken(request.headers.authorization);
        if (!token) throw unauthorized();
        await dependencies.auth.revokeSession(token);
        sendNoContent(response);
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/auth/sessions") {
        if (url.searchParams.size > 0) throw invalidArgument("登出接口不接受查询参数");
        if (hasRequestBody(request)) throw invalidArgument("登出接口不接受请求体");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        await dependencies.auth.revokeUserSessions(currentUser.id);
        sendNoContent(response);
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/media/ai/")) {
        if (url.searchParams.size > 0) throw invalidArgument("AI 文件地址不接受查询参数");
        const file = await dependencies.aiFiles.read(url.pathname);
        if (file) {
          sendImage(response, file, "private, no-store");
          return;
        }
      }

      if (request.method === "POST" && url.pathname === "/api/files/upload") {
        if (url.searchParams.size > 0) throw invalidArgument("文件上传接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const upload = await readSingleUploadedFile(
          request,
          "file",
          Math.max(
            dependencies.coverMaximumBytes,
            dependencies.aiFileMaximumBytes ?? dependencies.coverMaximumBytes,
          ),
          ["type", "securityCheckId"],
          "图片文件",
        );
        const type = upload.fields.type;
        const securityCheckId = upload.fields.securityCheckId;
        const fieldCount = Object.keys(upload.fields).length;
        if (
          (type !== "cover" && type !== "ai_input")
          || (type === "cover" && fieldCount !== 1)
          || (type === "ai_input" && fieldCount !== (securityCheckId ? 2 : 1))
        ) {
          throw invalidArgument("文件上传的 type 只能是 cover 或 ai_input");
        }
        const maximumBytes = type === "cover"
          ? dependencies.coverMaximumBytes
          : dependencies.aiFileMaximumBytes;
        if (upload.buffer.length > maximumBytes) {
          throw new AppError(413, "PAYLOAD_TOO_LARGE", "图片文件超过大小限制");
        }
        if (type === "ai_input") {
          dependencies.aiRateLimiter?.check(`${currentUser.id}:upload`);
          const contentSecurity = requireContentSecurity(dependencies);
          if (securityCheckId) {
            await contentSecurity.assertMediaCheck(currentUser.id, securityCheckId, upload.buffer);
          } else {
            await contentSecurity.checkMedia(currentUser.id, {
              buffer: upload.buffer,
              filename: upload.filename,
              contentType: upload.declaredContentType,
            });
          }
        }
        sendJson(response, 201, {
          file: await dependencies.files.upload(currentUser.id, {
            type,
            buffer: upload.buffer,
            filename: upload.filename,
            declaredContentType: upload.declaredContentType,
          }),
        });
        return;
      }

      const legalDocumentMatch = url.pathname.match(/^\/api\/legal-documents\/([^/]+)$/u);
      if (legalDocumentMatch && request.method === "GET") {
        if (url.searchParams.size > 0) throw invalidArgument("法律文档接口不接受查询参数");
        const key = legalDocumentMatch[1];
        if (!key) throw invalidArgument("法律文档 key 无效");
        sendJson(response, 200, { document: getLegalDocument(key) });
        return;
      }

      if (url.pathname.startsWith("/api/content-security/media/")) {
        if (request.method !== "GET" || url.searchParams.size > 0 || !dependencies.contentSecurity) {
          throw invalidArgument("内容安全媒体地址无效");
        }
        const media = await dependencies.contentSecurity.readMedia(url.pathname);
        if (media) {
          sendImage(response, media, "private, no-store");
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/api/wechat/content-security/callback") {
        if (!dependencies.contentSecurity?.verifyCallback(
          url.searchParams.get("signature") ?? undefined,
          url.searchParams.get("timestamp") ?? undefined,
          url.searchParams.get("nonce") ?? undefined,
        )) {
          throw new AppError(403, "INVALID_CALLBACK_SIGNATURE", "微信回调校验失败");
        }
        sendText(response, url.searchParams.get("echostr") ?? "success");
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/wechat/content-security/callback") {
        if (!dependencies.contentSecurity?.verifyCallback(
          url.searchParams.get("signature") ?? undefined,
          url.searchParams.get("timestamp") ?? undefined,
          url.searchParams.get("nonce") ?? undefined,
        )) {
          throw new AppError(403, "INVALID_CALLBACK_SIGNATURE", "微信回调校验失败");
        }
        await dependencies.contentSecurity.handleCallback(await readJsonObject(request));
        sendText(response, "success");
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/content-security/text") {
        if (url.searchParams.size > 0) throw new AppError(503, "CONTENT_SECURITY_NOT_CONFIGURED", "内容安全服务尚未配置");
        const contentSecurity = requireContentSecurity(dependencies);
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const trace = await contentSecurity.checkText(
          currentUser.id,
          validateContentSecurityTextBody(await readJsonObject(request)),
        );
        sendJson(response, 200, trace);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/content-security/media") {
        if (!dependencies.contentSecurity || url.searchParams.size > 0) {
          throw new AppError(503, "CONTENT_SECURITY_NOT_CONFIGURED", "内容安全服务尚未配置");
        }
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const upload = await readSingleUploadedFile(
          request,
          "file",
          dependencies.contentSecurityMediaMaximumBytes ?? 10 * 1_024 * 1_024,
          [],
          "待审核图片",
        );
        sendJson(response, 201, {
          check: await dependencies.contentSecurity.checkMedia(currentUser.id, {
            buffer: upload.buffer,
            filename: upload.filename,
            contentType: upload.declaredContentType,
          }),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/works") {
        if (url.searchParams.size > 0) throw invalidArgument("作品保存接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const validated = validateWorkBody(await readJsonObject(request, 2 * 1024 * 1024));
        await requireContentSecurity(dependencies).checkText(currentUser.id, validated.title);
        sendJson(response, 201, await dependencies.works.create({
          userId: currentUser.id,
          idempotencyKey: idempotencyKey(request),
          title: validated.title,
          coverFileId: validated.coverFileId,
          status: validated.status,
          validatedPattern: validatePersistedPattern(validated.pattern),
        }));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/works") {
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        sendJson(response, 200, await dependencies.works.list(listOptions(url, currentUser.id)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/favorites") {
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        sendJson(response, 200, await dependencies.works.listFavorites(favoriteListOptions(url, currentUser.id)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/quota/me") {
        if (url.searchParams.size > 0) throw invalidArgument("额度接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        sendJson(response, 200, await dependencies.quotaDownloads.getQuota(currentUser.id));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/downloads") {
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        sendJson(response, 200, await dependencies.quotaDownloads.listDownloads(downloadListOptions(url, currentUser.id)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/downloads") {
        if (url.searchParams.size > 0) throw invalidArgument("下载记录接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const body = validateDownloadBody(await readJsonObject(request));
        sendJson(response, 201, await dependencies.quotaDownloads.createDownload({
          userId: currentUser.id,
          idempotencyKey: idempotencyKey(request),
          workId: body.workId,
          fileType: body.fileType,
        }));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/ai/generations") {
        if (url.searchParams.size > 0) throw invalidArgument("AI 生成接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const body = validateCreateAiGenerationBody(await readJsonObject(request));
        dependencies.aiRateLimiter?.check(`${currentUser.id}:generation`);
        sendJson(response, 201, await dependencies.aiGenerations.create({
          userId: currentUser.id,
          requestId: id,
          idempotencyKey: idempotencyKey(request),
          ...body,
        }));
        return;
      }

      const requestedAiGenerationId = aiGenerationId(url.pathname);
      if (requestedAiGenerationId && request.method === "GET") {
        if (url.searchParams.size > 0) throw invalidArgument("AI 生成任务接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        sendJson(response, 200, await dependencies.aiGenerations.get(currentUser.id, requestedAiGenerationId, id));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/packages") {
        if (url.searchParams.size > 0) throw invalidArgument("套餐接口不接受查询参数");
        sendJson(response, 200, await dependencies.payments.listPackages());
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/orders") {
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        sendJson(response, 200, await dependencies.payments.listOrders(orderListOptions(url, currentUser.id)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/payments/create") {
        if (url.searchParams.size > 0) throw invalidArgument("支付创建接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const packageId = validateCreatePaymentBody(await readJsonObject(request));
        sendJson(response, 201, await dependencies.payments.createPayment({
          userId: currentUser.id,
          packageId,
          idempotencyKey: idempotencyKey(request),
        }));
        return;
      }

      // 订单页的两个支付订单操作：继续支付（复用原订单重新拉起）与主动取消。
      // 都要求登录；orderId 在服务端做归属校验，路径里带什么都拿不到别人的订单。
      const paymentOrderActionRoute = paymentOrderAction(url.pathname);
      if (request.method === "POST" && paymentOrderActionRoute) {
        if (url.searchParams.size > 0) throw invalidArgument("支付订单操作接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        if (paymentOrderActionRoute.action === "continue") {
          sendJson(response, 200, await dependencies.payments.continuePayment({
            userId: currentUser.id,
            orderId: paymentOrderActionRoute.orderId,
          }));
        } else {
          sendJson(response, 200, await dependencies.payments.cancelOrder({
            userId: currentUser.id,
            orderId: paymentOrderActionRoute.orderId,
          }));
        }
        return;
      }

      // 虚拟支付发货推送（xpay_goods_deliver_notify）：MP 后台需配置为回调 URL + 订阅该事件。
      // 与旧 notify 分开是两个独立端点：两套协议的报文格式与响应要求都不同，混在一个路由里
      // 只能靠猜 Content-Type 分支，出错时还难以定位是哪条链路。
      /**
       * GET 不是业务请求，而是 MP 后台的 URL 握手：点「保存」或「模拟推送」时微信会带
       * signature / timestamp / nonce / echostr 打过来，校验通过后必须**原样回显 echostr**，
       * 否则后台直接判定 URL 不可用 —— 连配置都存不进去，后面一条推送都收不到。
       */
      if (request.method === "GET" && url.pathname === "/api/payments/virtual-notify") {
        const push = dependencies.virtualPayPush;
        if (!push?.token) {
          throw new AppError(503, "VIRTUAL_PAY_PUSH_NOT_CONFIGURED", "虚拟支付推送尚未配置 Token");
        }
        if (!verifyPushSignature(push.token, {
          signature: url.searchParams.get("signature") ?? undefined,
          timestamp: url.searchParams.get("timestamp") ?? undefined,
          nonce: url.searchParams.get("nonce") ?? undefined,
        })) {
          throw new AppError(403, "INVALID_CALLBACK_SIGNATURE", "微信回调校验失败");
        }
        sendText(response, url.searchParams.get("echostr") ?? "success");
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/payments/virtual-notify") {
        const push = dependencies.virtualPayPush;
        /**
         * 这里曾经拒绝一切带查询参数的请求，等于把全部推送都 400 掉 —— 微信 POST 时
         * 一定带 signature / timestamp / nonce（安全模式还带 msg_signature、encrypt_type）。
         * 现在改成「校验而不是拒绝」。
         */
        const query = {
          signature: url.searchParams.get("signature") ?? undefined,
          msgSignature: url.searchParams.get("msg_signature") ?? undefined,
          timestamp: url.searchParams.get("timestamp") ?? undefined,
          nonce: url.searchParams.get("nonce") ?? undefined,
        };
        const received = await readRawBody(request);
        let rawBody = received;
        try {
          if (!push?.token) {
            throw new AppError(503, "VIRTUAL_PAY_PUSH_NOT_CONFIGURED", "虚拟支付推送未配置验签 Token");
          }
          // 没配 EncodingAESKey 就说明后台选的是明文模式，硬解只会把明文当密文炸掉
          const ciphertext = push?.encodingAesKey ? extractPushCiphertext(received) : null;
          if (!verifyPushRequest(push, query, ciphertext)) {
            throw new AppError(403, "INVALID_CALLBACK_SIGNATURE", "虚拟支付推送签名校验失败");
          }
          if (ciphertext && push?.encodingAesKey) {
            rawBody = decryptPushBody(ciphertext, push.encodingAesKey, push.appId);
          }
        } catch (error: unknown) {
          /**
           * 验签 / 解密失败一律回 ErrCode=1 而不是 4xx：这类故障的根因在配置，
           * 重试多少次结果都一样，回 4xx 会被平台当成网络失败重试 15 次，
           * 把真正需要人看的告警淹没在噪音里。
           */
          console.error(JSON.stringify({
            event: "virtual_payment_push_rejected",
            requestId: id,
            errorCode: error instanceof AppError ? error.code : "UNKNOWN",
          }));
          sendRaw(
            response,
            200,
            "application/xml",
            "<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[处理失败]]></ErrMsg></xml>",
          );
          return;
        }
        const eventName = parseEventName(rawBody);

        /**
         * iOS 退款问询走**完全独立的应答协议**：回的是 result_code / result_info / evidence，
         * 不是 ErrCode。而且它有时限 —— 3 秒内不答，平台就向 Apple 回「不确定」。
         * 所以异常分支也必须答，宁可放过（result_code=0）也不能不答：
         * 不答等于放弃举证、把退款决定权整个交给 Apple。
         */
        if (eventName === IOS_REFUND_QUERY_EVENT) {
          try {
            const answer = await dependencies.payments.answerIosRefundQuery(parseIosRefundQuery(rawBody));
            sendJson(response, 200, {
              result_code: answer.resultCode,
              result_info: answer.resultInfo,
              evidence: answer.evidence,
            });
          } catch {
            console.error(JSON.stringify({
              event: "virtual_payment_ios_refund_query_failed",
              requestId: id,
            }));
            sendJson(response, 200, {
              result_code: 0,
              result_info: "处理异常，不主张拒绝退款",
              evidence: "服务端未能完成举证",
            });
          }
          return;
        }

        const handler = eventName === REFUND_EVENT
          ? async () => {
            await dependencies.payments.handleRefund(parseRefundNotification(rawBody));
          }
          : eventName === DELIVERY_EVENT
            ? async () => {
              // 已按事件名确认过是发货推送，这里的 null 分支只可能是解析层的防御性返回
              const delivery = parseDeliveryNotification(rawBody);
              if (delivery) await dependencies.payments.handleDelivery(delivery);
            }
            : null;

        /**
         * 其余 xpay_* 事件（退款/投诉/风控/代币支付）一律回成功让平台停止重试，
         * 但**必须留下事件名**。此前这里是静默吞掉的：商户被管控、用户发起投诉
         * 这种事发生时我们连一行日志都没有。
         */
        if (handler === null) {
          console.warn(JSON.stringify({
            event: "virtual_payment_event_ignored",
            requestId: id,
            eventName,
          }));
          sendRaw(
            response,
            200,
            "application/xml",
            "<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>",
          );
          return;
        }

        try {
          await handler();
          sendRaw(
            response,
            200,
            "application/xml",
            "<xml><ErrCode>0</ErrCode><ErrMsg><![CDATA[success]]></ErrMsg></xml>",
          );
        } catch (error: unknown) {
          if (error instanceof AppError) {
            console.warn(JSON.stringify({
              event: "virtual_payment_callback_rejected",
              requestId: id,
              eventName,
              errorCode: error.code,
            }));
          } else {
            console.error(JSON.stringify({
              event: "virtual_payment_callback_failed",
              requestId: id,
              eventName,
            }));
          }
          // 必须返回 200 + ErrCode≠0：平台只在 HTTP 层成功时才读 ErrCode 决定是否重试，
          // 直接回 4xx/5xx 会被当作网络失败，导致同样的错误被重试 15 次。
          sendRaw(
            response,
            200,
            "application/xml",
            "<xml><ErrCode>1</ErrCode><ErrMsg><![CDATA[处理失败]]></ErrMsg></xml>",
          );
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/payments/notify") {
        if (url.searchParams.size > 0) throw invalidArgument("微信支付回调接口不接受查询参数");
        try {
          const notification = await readRawJsonObject(request);
          await dependencies.payments.handleNotification({
            rawBody: notification.rawBody,
            headers: wechatPaymentHeaders(request),
          });
          sendJson(response, 200, { code: "SUCCESS", message: "成功" });
        } catch (error: unknown) {
          if (error instanceof AppError) {
            console.warn(JSON.stringify({
              event: "wechat_payment_notification_rejected",
              requestId: id,
              errorCode: error.code,
            }));
            sendJson(response, error.statusCode, { code: "FAIL", message: error.message });
          } else {
            console.error(JSON.stringify({ event: "wechat_payment_notification_failed", requestId: id }));
            sendJson(response, 500, { code: "FAIL", message: "服务内部错误" });
          }
        }
        return;
      }

      const requestedFavoriteWorkId = favoriteWorkId(url.pathname);
      if (requestedFavoriteWorkId && request.method === "PATCH") {
        if (url.searchParams.size > 0) throw invalidArgument("收藏操作接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        const favorite = validateFavoriteBody(await readJsonObject(request));
        sendJson(response, 200, await dependencies.works.setFavorite(currentUser.id, requestedFavoriteWorkId, favorite));
        return;
      }

      const requestedWorkId = workId(url.pathname);
      if (requestedWorkId && (request.method === "GET" || request.method === "DELETE" || request.method === "PATCH" || request.method === "PUT")) {
        if (url.searchParams.size > 0) throw invalidArgument("作品详情接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(request.headers.authorization);
        if (request.method === "GET") {
          sendJson(response, 200, await dependencies.works.get(currentUser.id, requestedWorkId));
        } else if (request.method === "DELETE") {
          await dependencies.works.delete(currentUser.id, requestedWorkId);
          sendNoContent(response);
        } else {
          const update = validateWorkUpdateBody(await readJsonObject(request, 2 * 1024 * 1024));
          if (update.title !== undefined) {
            await requireContentSecurity(dependencies).checkText(currentUser.id, update.title);
          }
          sendJson(response, 200, await dependencies.works.update({
            userId: currentUser.id,
            workId: requestedWorkId,
            ...update,
          }));
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/users/me") {
        if (url.searchParams.size > 0) throw invalidArgument("当前用户接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(
          request.headers.authorization,
        );
        sendJson(response, 200, await dependencies.users.getCurrentUser(currentUser.id));
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/users/me/privacy") {
        if (url.searchParams.size > 0) throw invalidArgument("隐私偏好接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(
          request.headers.authorization,
        );
        sendJson(response, 200, { privacy: await dependencies.users.getPrivacyPreferences(currentUser.id) });
        return;
      }

      if (request.method === "PATCH" && url.pathname === "/api/users/me/privacy") {
        if (url.searchParams.size > 0) throw invalidArgument("隐私偏好接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(
          request.headers.authorization,
        );
        const privacy = await dependencies.users.updatePrivacyPreferences(
          currentUser.id,
          validatePrivacyPatch(await readJsonObject(request)),
        );
        sendJson(response, 200, { privacy });
        return;
      }

      if (request.method === "DELETE" && url.pathname === "/api/users/me") {
        if (url.searchParams.size > 0) throw invalidArgument("账号注销接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(
          request.headers.authorization,
        );
        await dependencies.users.deleteAccount(currentUser.id);
        sendNoContent(response);
        return;
      }


      if ((request.method === "PATCH" || request.method === "PUT") && url.pathname === "/api/users/me") {
        if (url.searchParams.size > 0) throw invalidArgument("当前用户接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(
          request.headers.authorization,
        );
        const nickname = validateNicknameBody(await readJsonObject(request));
        sendJson(response, 200, { user: await dependencies.users.updateNickname(currentUser.id, nickname) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/users/me/avatar") {
        if (url.searchParams.size > 0) throw invalidArgument("头像上传接口不接受查询参数");
        const currentUser = await dependencies.authenticator.authenticate(
          request.headers.authorization,
        );
        const upload = await readSingleUploadedFile(
          request,
          "file",
          dependencies.avatarMaximumBytes,
          ["nickname"],
          "头像文件",
        );
        const nickname = validateNicknameBody({ nickname: upload.fields.nickname });
        const avatar = await dependencies.avatars.save(upload.buffer, upload.declaredContentType);
        try {
          const updated = await dependencies.users.updateProfileWithAvatar(
            currentUser.id,
            nickname,
            avatar.publicPath,
          );
          await dependencies.avatars.remove(updated.previousAvatarUrl);
          sendJson(response, 200, { user: updated.user });
        } catch (error: unknown) {
          await dependencies.avatars.remove(avatar.publicPath);
          throw error;
        }
        return;
      }

      sendJson(response, 404, errorPayload("NOT_FOUND", "接口不存在", id));
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        if (error instanceof AppError) {
          const failure = aiPublicFailure(error.code);
          sendJson(
            response,
            failure ? aiPublicHttpStatus(error.code, error.statusCode) : error.statusCode,
            errorPayload(
              failure?.code ?? error.code,
              failure?.message ?? error.message,
              id,
              publicErrorDetails(error),
              failure,
            ),
          );
        } else {
          console.error(JSON.stringify({
            event: "request_failed",
            requestId: id,
            method: request.method,
            pathname: new URL(request.url ?? "/", "http://localhost").pathname,
          }));
          sendJson(response, 500, errorPayload("INTERNAL_ERROR", "服务内部错误", id));
        }
      } else {
        response.destroy();
      }
    });
  };
}

function publicErrorDetails(error: AppError): Readonly<Record<string, unknown>> {
  if (error.code === "ORDER_ALREADY_PAID") {
    const orderId = error.details.orderId;
    return typeof orderId === "string" && /^order_[A-Za-z0-9_-]{1,26}$/.test(orderId)
      ? { orderId }
      : {};
  }
  if (error.code !== "RATE_LIMITED") return {};
  const retryAfterSeconds = error.details.retryAfterSeconds;
  return typeof retryAfterSeconds === "number" && Number.isSafeInteger(retryAfterSeconds)
    ? { retryAfterSeconds }
    : {};
}
