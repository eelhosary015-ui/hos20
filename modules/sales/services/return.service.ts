import { ReturnRepository } from "../repositories/return.repository.js";
import { CreateReturnDTO, UpdateReturnDTO } from "../dto/return.dto.js";
import { ERPCache, ERPEventBus, erpPool } from "../../../server-erp-core.js";
import { moveStock } from "../../warehouses/services/inventory.service.js";
import { CustomerService } from "../../customers/services/customer.service.js";
import { SafeService } from "../../accounting/services/safe.service.js";
import { postReturnEntry } from "../../accounts/services/auto-posting.service.js";

const LIST_CACHE_KEY = "sales:returns:all";

export class ReturnService {
  private repository: ReturnRepository;
  private customerService: CustomerService;
  private safeService: SafeService;

  constructor() {
    this.repository = new ReturnRepository();
    this.customerService = new CustomerService();
    this.safeService = new SafeService();
  }

  async getReturns(): Promise<any[]> {
    const cached = ERPCache.get(LIST_CACHE_KEY);
    if (cached) return cached;

    const returns = await this.repository.getAll();
    ERPCache.set(LIST_CACHE_KEY, returns, 60);
    return returns;
  }

  async getReturnById(id: number): Promise<any> {
    const returnDoc = await this.repository.getById(id);
    if (!returnDoc) {
      const err: any = new Error("Sales return not found");
      err.statusCode = 404;
      throw err;
    }
    return returnDoc;
  }

  /**
   * Creates a sales return and fully integrates it with:
   * 1. Warehouses: restocks items back into the inventory
   * 2. Customers: adjusts balance (credit note) or refunds cash
   * 3. Treasury / Safe: withdraws cash if cash refund
   * 4. Accounting: double-entry GL auto-posting for sales returns
   */
  async createReturn(dto: CreateReturnDTO): Promise<any> {
    const integrationWarnings: string[] = [];
    const client = await erpPool.connect();
    let returnDoc: any;
    let totalCost = 0;
    let warehouseId = Number(dto.warehouseId) || 1;
    try {
      await client.query("BEGIN");

      if (!dto.warehouseId && dto.warehouse) {
        const warehouse = await client.query(
          "SELECT id FROM warehouses WHERE name ILIKE $1 OR id::text = $1 LIMIT 1",
          [dto.warehouse]
        );
        if (warehouse.rows.length) warehouseId = Number(warehouse.rows[0].id);
      }

      let sourceInvoiceItems: any[] = [];
      if (dto.invoiceId) {
        const sourceInvoice = await client.query(
          `SELECT id FROM sales_invoices
            WHERE id::text = $1 OR invoice_no = $1
            ORDER BY CASE WHEN id::text = $1 THEN 0 ELSE 1 END
            LIMIT 1`,
          [String(dto.invoiceId)]
        );
        if (!sourceInvoice.rows.length) throw new Error(`فاتورة المبيعات الأصلية غير موجودة: ${dto.invoiceId}`);
        const sourceLines = await client.query(
          `SELECT ingredient_id, product_id, code, name, unit_cost, qty
             FROM sales_invoice_items WHERE invoice_id = $1 ORDER BY id`,
          [sourceInvoice.rows[0].id]
        );
        sourceInvoiceItems = sourceLines.rows;
      }

      const costedItems = [];
      for (const item of dto.items || []) {
        const qty = Number(item.qtyReturned) || 0;
        if (qty <= 0) throw new Error(`كمية المرتجع غير صحيحة للصنف "${item.itemName}"`);

        const sourceItem = sourceInvoiceItems.find((line: any) =>
          (item.ingredientId && Number(line.ingredient_id) === Number(item.ingredientId)) ||
          (item.itemCode && line.code === item.itemCode) ||
          (item.itemName && line.name === item.itemName)
        );
        if (dto.invoiceId && sourceInvoiceItems.length && !sourceItem) {
          throw new Error(`الصنف "${item.itemName}" غير موجود في فاتورة المبيعات المرتبطة`);
        }

        let ingredientId = Number(item.ingredientId || sourceItem?.ingredient_id) || null;
        if (!ingredientId) {
          const ingredient = await client.query(
            `SELECT id FROM ingredients
              WHERE (code = $1 AND $1 <> '') OR name ILIKE $2
              ORDER BY CASE WHEN code = $1 THEN 0 ELSE 1 END
              LIMIT 1`,
            [item.itemCode || "", item.itemName || ""]
          );
          ingredientId = Number(ingredient.rows[0]?.id) || null;
        }

        let unitCost = Number(sourceItem?.unit_cost) || 0;
        if (!unitCost && ingredientId) {
          const stock = await client.query(
            `SELECT avg_cost, unit_cost, last_cost, cost
               FROM inventory_items
              WHERE warehouse_id = $1 AND ingredient_id = $2
              ORDER BY id
              LIMIT 1
              FOR UPDATE`,
            [warehouseId, ingredientId]
          );
          const stockRow = stock.rows[0];
          unitCost = [
            stockRow?.avg_cost,
            stockRow?.unit_cost,
            stockRow?.last_cost,
            stockRow?.cost,
          ].map((value) => Number(value) || 0).find((value) => value > 0) || 0;
          if (!unitCost) {
            const ingredient = await client.query(
              "SELECT avg_cost, cost_price, last_purchase_price, cost FROM ingredients WHERE id = $1",
              [ingredientId]
            );
            const ingredientRow = ingredient.rows[0];
            unitCost = [
              ingredientRow?.avg_cost,
              ingredientRow?.cost_price,
              ingredientRow?.last_purchase_price,
              ingredientRow?.cost,
            ].map((value) => Number(value) || 0).find((value) => value > 0) || 0;
          }
        }

        if (!ingredientId) unitCost = 0;
        const totalItemCost = qty * unitCost;
        totalCost += totalItemCost;
        costedItems.push({ ...item, ingredientId, unitCost, totalCost: totalItemCost });
      }

      returnDoc = await this.repository.create({
        ...dto,
        warehouseId,
        totalCost,
        items: costedItems
      }, client);

      let movementTotalCost = 0;
      for (let index = 0; index < costedItems.length; index++) {
        const item = costedItems[index];
        if (!item.ingredientId) continue;
        const movement = await moveStock(client, {
          warehouse_id: warehouseId,
          ingredient_id: item.ingredientId,
          delta: Number(item.qtyReturned),
          ref_type: "sales_return",
          ref_id: Number(returnDoc.id),
          unit_cost: Number(item.unitCost) > 0 ? Number(item.unitCost) : undefined,
          user: dto.salesRep || "sales_module",
          notes: `مرتجع مبيعات ${returnDoc.return_no || returnDoc.id} — ${item.itemName}`
        });
        item.unitCost = Number(movement.unit_cost) || 0;
        item.totalCost = Number(movement.total_cost) || 0;
        movementTotalCost += item.totalCost;
      }
      totalCost = movementTotalCost;

      const returnItemIds = await client.query(
        "SELECT id FROM sales_return_items WHERE return_id = $1 ORDER BY id",
        [returnDoc.id]
      );
      for (let index = 0; index < costedItems.length; index++) {
        const itemId = returnItemIds.rows[index]?.id;
        if (!itemId) continue;
        await client.query(
          "UPDATE sales_return_items SET unit_cost = $1, total_cost = $2 WHERE id = $3",
          [costedItems[index].unitCost, costedItems[index].totalCost, itemId]
        );
      }

      const grandTotal = Number(dto.grandTotal) || 0;
      const itemsTotal = Number(dto.itemsTotal) || 0;
      const taxTotal = Number(dto.taxTotal) || 0;
      const journalEntry = await postReturnEntry({
        id: Number(returnDoc.id),
        grand_total: grandTotal,
        refund_method: dto.refundMethod || "إشعار دائن للعميل",
        customer_name: dto.customerName,
        items_total: itemsTotal,
        tax_total: taxTotal,
        total_cost: totalCost,
        branch_id: 1
      }, client);
      if ((grandTotal > 0 || totalCost > 0) && !journalEntry?.id) {
        throw new Error(`تعذر إنشاء قيد مرتجع المبيعات #${returnDoc.return_no || returnDoc.id}`);
      }
      await client.query(
        "UPDATE sales_returns SET total_cost = $1, journal_entry_id = $2 WHERE id = $3",
        [totalCost, journalEntry?.id || null, returnDoc.id]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    ERPCache.delete(LIST_CACHE_KEY);
    returnDoc = await this.repository.getById(Number(returnDoc.id));

    const grandTotal = parseFloat(returnDoc.grandTotal || 0);

    // 2) Customer balance & transactions
    let customerId = dto.customerId;
    if (!customerId && dto.customerName) {
      try {
        const custRes = await erpPool.query("SELECT id FROM customers WHERE name ILIKE $1 LIMIT 1", [dto.customerName]);
        if (custRes.rows.length > 0) {
          customerId = custRes.rows[0].id;
        }
      } catch (_) {}
    }

    const isCreditRefund = (dto.refundMethod || "إشعار دائن للعميل") === "إشعار دائن للعميل" || (dto.refundMethod || "").includes("دائن") || (dto.refundMethod || "").includes("حساب");

    if (customerId && isCreditRefund) {
      try {
        await this.customerService.recordTransaction({
          customer_id: customerId,
          amount: grandTotal,
          type: "payment", // payment credits customer balance (reduces debt)
          notes: `إشعار دائن مرتجع مبيعات ${returnDoc.return_no || returnDoc.returnNo}`
        });
      } catch (e: any) {
        integrationWarnings.push(`تعذر تخفيض رصيد العميل بالمرتجع: ${e.message}`);
      }
    }

    // 3) Treasury / Safe: If cash refund, record cash withdrawal from safe
    if (!isCreditRefund && grandTotal > 0) {
      try {
        const safes = await this.safeService.getSafes();
        const targetSafe = safes.length > 0 ? safes[0] : null;
        if (targetSafe) {
          await this.safeService.adjustSafeBalance(targetSafe.id, {
            amount: grandTotal,
            type: "out",
            notes: `صرف مردود مبيعات نقدي ${returnDoc.return_no || returnDoc.returnNo} — ${dto.customerName}`
          });
        }
      } catch (e: any) {
        console.warn("Could not record safe withdrawal for return:", e.message);
      }
    }

    ERPEventBus.getInstance().emitEvent("SalesReturnCreated", {
      returnId: returnDoc.id,
      returnNo: returnDoc.return_no || returnDoc.returnNo,
      customerName: returnDoc.customer_name || returnDoc.customerName,
      grandTotal,
      timestamp: new Date()
    });

    return { ...returnDoc, totalCost, integrationWarnings };
  }

  async updateReturn(id: number, dto: UpdateReturnDTO): Promise<any> {
    const found = await this.repository.getById(id);
    if (!found) {
      const err: any = new Error("Return not found");
      err.statusCode = 404;
      throw err;
    }

    if (found.status === "تم التأكيد والمحاسبة") {
      const err: any = new Error("Cannot edit a return that has already been confirmed and posted");
      err.statusCode = 409;
      throw err;
    }

    const returnDoc = await this.repository.update(id, dto);
    ERPCache.delete(LIST_CACHE_KEY);

    ERPEventBus.getInstance().emitEvent("SalesReturnUpdated", {
      returnId: id,
      timestamp: new Date()
    });

    return returnDoc;
  }

  async deleteReturn(id: number): Promise<void> {
    const found = await this.repository.getById(id);
    if (!found) {
      const err: any = new Error("Return not found");
      err.statusCode = 404;
      throw err;
    }

    if (found.status === "تم التأكيد والمحاسبة") {
      const err: any = new Error("Cannot delete a return that has already been confirmed and posted");
      err.statusCode = 409;
      throw err;
    }

    await this.repository.delete(id);
    ERPCache.delete(LIST_CACHE_KEY);

    ERPEventBus.getInstance().emitEvent("SalesReturnDeleted", {
      returnId: id,
      timestamp: new Date()
    });
  }
}
