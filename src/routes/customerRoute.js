/**
 * ==========================================================================
 * CUSTOMER ACCOUNT ROUTER (`src/routes/customerRoute.js`)
 * Nails by Divya Platform
 *
 * Provides customer self-service account management:
 * - GET    /api/customer/profile        -> Get customer profile details
 * - PUT    /api/customer/profile        -> Update customer profile details
 * - GET    /api/customer/addresses      -> List saved user addresses
 * - POST   /api/customer/addresses      -> Add a new user address
 * - PUT    /api/customer/addresses/:id  -> Update an existing address
 * - DELETE /api/customer/addresses/:id  -> Delete an address
 * ==========================================================================
 */

const express = require("express");
const { requireAuth } = require("../middleware/auth");
const {
  getCustomerProfile,
  updateCustomerProfile,
  getUserAddresses,
  createUserAddress,
  updateUserAddress,
  deleteUserAddress,
} = require("../services/userService");

const router = express.Router();

// All customer routes require authentication
router.use(requireAuth);

/**
 * GET /api/customer/profile
 * Retrieves customer profile attributes and measurements.
 */
router.get("/profile", async (req, res) => {
  try {
    const profile = await getCustomerProfile(req.user.id);
    res.json({
      status: "success",
      profile,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({
      error: err.message || "Failed to retrieve customer profile.",
      code: err.code || "PROFILE_ERROR",
    });
  }
});

/**
 * PUT /api/customer/profile
 * Updates customer profile preferences, nail sizes, and notes.
 */
router.put("/profile", async (req, res) => {
  try {
    const updated = await updateCustomerProfile(req.user.id, req.body || {});
    res.json({
      status: "success",
      message: "Customer profile updated successfully.",
      profile: updated,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({
      error: err.message || "Failed to update customer profile.",
      code: err.code || "PROFILE_UPDATE_ERROR",
      details: err.details,
    });
  }
});

/**
 * GET /api/customer/addresses
 * Lists all addresses saved by the customer.
 */
router.get("/addresses", async (req, res) => {
  try {
    const addresses = await getUserAddresses(req.user.id);
    res.json({
      status: "success",
      addresses,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({
      error: err.message || "Failed to retrieve user addresses.",
      code: err.code || "ADDRESS_RETRIEVAL_ERROR",
    });
  }
});

/**
 * POST /api/customer/addresses
 * Creates a new address for the customer.
 */
router.post("/addresses", async (req, res) => {
  try {
    const address = await createUserAddress(req.user.id, req.body || {});
    res.status(201).json({
      status: "success",
      message: "Address added successfully.",
      address,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({
      error: err.message || "Failed to add address.",
      code: err.code || "ADDRESS_CREATE_ERROR",
      details: err.details,
    });
  }
});

/**
 * PUT /api/customer/addresses/:id
 * Updates an address owned by the customer.
 */
router.put("/addresses/:id", async (req, res) => {
  try {
    const addressId = req.params.id;
    const address = await updateUserAddress(req.user.id, addressId, req.body || {});
    res.json({
      status: "success",
      message: "Address updated successfully.",
      address,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({
      error: err.message || "Failed to update address.",
      code: err.code || "ADDRESS_UPDATE_ERROR",
      details: err.details,
    });
  }
});

/**
 * DELETE /api/customer/addresses/:id
 * Deletes an address owned by the customer.
 */
router.delete("/addresses/:id", async (req, res) => {
  try {
    const addressId = req.params.id;
    await deleteUserAddress(req.user.id, addressId);
    res.json({
      status: "success",
      message: "Address deleted successfully.",
      addressId,
    });
  } catch (err) {
    const status = err.statusCode || 500;
    res.status(status).json({
      error: err.message || "Failed to delete address.",
      code: err.code || "ADDRESS_DELETE_ERROR",
    });
  }
});

module.exports = router;
