import { describe, it, expect, vi, beforeEach } from 'vitest';

// dashboard.service.js calls query() 14 times in a fixed order to build the
// dashboard summary. We mock db.js entirely so this test never touches a
// real database and stays fast/deterministic.
vi.mock('../../config/db.js', () => ({
  query: vi.fn()
}));

const { query } = await import('../../config/db.js');
const { getSummary } = await import('../dashboard.service.js');

describe('dashboard.service getSummary', () => {
  beforeEach(() => {
    query.mockReset();
  });

  it('maps every aggregate query into the expected counters/coverage shape', async () => {
    query
      // productsMeta
      .mockResolvedValueOnce([{
        total_products: 10,
        active_products: 8,
        products_with_barcode: 4,
        cold_chain_products: 2,
        // Regression guard for the incident where a runtime migration
        // dropped productos.es_controlado and broke this exact query.
        controlled_products: 3
      }])
      // productsWithImages
      .mockResolvedValueOnce([{ total: 5 }])
      // stockHealth
      .mockResolvedValueOnce([{
        out_of_stock: 1,
        critical_stock: 2,
        low_stock: 3,
        healthy_stock: 4,
        inventory_value: 1234.56
      }])
      // expirationMeta
      .mockResolvedValueOnce([{ expired_lots: 1, expiring_30: 2, expiring_90: 3 }])
      // coldAlerts
      .mockResolvedValueOnce([{ total: 6 }])
      // openPurchases
      .mockResolvedValueOnce([{ total: 7 }])
      // openInvoices
      .mockResolvedValueOnce([{ total: 8 }])
      // lowStock
      .mockResolvedValueOnce([{ sku: 'SKU-1', nombre_comercial: 'Producto 1' }])
      // expiringLots
      .mockResolvedValueOnce([{ numero_lote: 'L-1' }])
      // categoryBreakdown
      .mockResolvedValueOnce([{ categoria: 'Analgésicos', unidades: 100, valor: 500 }])
      // storageBreakdown
      .mockResolvedValueOnce([{ tipo_almacen: 'Refrigerado', unidades: 50, valor: 250 }])
      // monthlyMovements
      .mockResolvedValueOnce([{ periodo: '2026-08', ingresos: 10, egresos: 5 }])
      // recentScans
      .mockResolvedValueOnce([{ codigo_barras: '123', nombre_comercial: 'Producto 1' }])
      // coldChainStatus
      .mockResolvedValueOnce([{ equipo: 'Nevera 1', estado: 'en_rango' }]);

    const summary = await getSummary();

    expect(query).toHaveBeenCalledTimes(14);

    expect(summary.counters).toMatchObject({
      products: 8,
      totalProducts: 10,
      productsWithBarcode: 4,
      productsWithImages: 5,
      coldChainProducts: 2,
      controlledProducts: 3,
      lowStock: 3,
      criticalStock: 2,
      outOfStock: 1,
      healthyStock: 4,
      inventoryValue: 1234.56,
      expiredLots: 1,
      lotsExpiring30Days: 2,
      lotsExpiring90Days: 3,
      coldChainOpenAlerts: 6,
      purchasesPendingReceipt: 7,
      invoicesPendingSync: 8
    });

    // barcodePct = round(4/8 * 100), imagesPct = round(5/8 * 100)
    expect(summary.coverage).toEqual({ barcodePct: 50, imagesPct: 63 });

    expect(summary.lowStock).toEqual([{ sku: 'SKU-1', nombre_comercial: 'Producto 1' }]);
    expect(summary.categoryBreakdown).toEqual([{ categoria: 'Analgésicos', unidades: 100, valor: 500 }]);
    expect(summary.coldChainStatus).toEqual([{ equipo: 'Nevera 1', estado: 'en_rango' }]);
  });

  it('falls back to zeroed counters/coverage when aggregate rows are empty', async () => {
    query.mockResolvedValue([]);

    const summary = await getSummary();

    expect(summary.counters.products).toBe(0);
    expect(summary.counters.controlledProducts).toBe(0);
    expect(summary.coverage).toEqual({ barcodePct: 0, imagesPct: 0 });
  });
});
