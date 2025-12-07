const express = require('express');
const bcrypt = require('bcrypt');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { exec } = require('child_process');
const util = require('util');
require('dotenv').config();

const execPromise = util.promisify(exec);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '../')));

// Database connection
const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD
});

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('Database connection error:', err);
    } else {
        console.log('Database connected successfully');
    }
});

// Create database tables
const createTables = async () => {
    try {
        // Gallery table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS gallery_items (
                id SERIAL PRIMARY KEY,
                filename VARCHAR(255) NOT NULL,
                original_name VARCHAR(255) NOT NULL,
                file_type VARCHAR(50) NOT NULL,
                file_size INTEGER,
                caption TEXT,
                category VARCHAR(100),
                is_featured BOOLEAN DEFAULT false,
                display_order INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('Gallery table ready');

        // Services table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS services (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                duration_minutes INTEGER NOT NULL DEFAULT 60,
                price DECIMAL(10, 2),
                show_price BOOLEAN DEFAULT true,
                is_active BOOLEAN DEFAULT true,
                display_order INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('Services table ready');

        // Insert default services if table is empty
        const servicesCount = await pool.query('SELECT COUNT(*) FROM services');
        if (servicesCount.rows[0].count === '0') {
            await pool.query(`
                INSERT INTO services (name, description, duration_minutes, price, display_order) VALUES
                ('Interior Detailing', 'Complete interior cleaning and protection', 120, 150.00, 1),
                ('Exterior Detailing', 'Full exterior wash, polish, and wax', 90, 120.00, 2),
                ('Ceramic Coating', 'Professional ceramic coating protection', 240, 500.00, 3)
            `);
            console.log('Default services inserted');
        }

        // Bookings table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS bookings (
                id SERIAL PRIMARY KEY,
                customer_name VARCHAR(255) NOT NULL,
                customer_email VARCHAR(255) NOT NULL,
                customer_phone VARCHAR(50) NOT NULL,
                service_ids INTEGER[] NOT NULL,
                booking_date DATE NOT NULL,
                booking_time TIME NOT NULL,
                total_duration INTEGER NOT NULL,
                total_price DECIMAL(10, 2),
                payment_method VARCHAR(50),
                payment_status VARCHAR(50) DEFAULT 'pending',
                status VARCHAR(50) DEFAULT 'confirmed',
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('Bookings table ready');

        // Business hours table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS business_hours (
                id SERIAL PRIMARY KEY,
                day_of_week INTEGER NOT NULL CHECK (day_of_week >= 0 AND day_of_week <= 6),
                is_open BOOLEAN DEFAULT true,
                open_time TIME,
                close_time TIME,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(day_of_week)
            )
        `);
        console.log('Business hours table ready');

        // Insert default business hours if empty
        const hoursCount = await pool.query('SELECT COUNT(*) FROM business_hours');
        if (hoursCount.rows[0].count === '0') {
            await pool.query(`
                INSERT INTO business_hours (day_of_week, is_open, open_time, close_time) VALUES
                (0, false, null, null),
                (1, true, '09:00', '17:00'),
                (2, true, '09:00', '17:00'),
                (3, true, '09:00', '17:00'),
                (4, true, '09:00', '17:00'),
                (5, true, '09:00', '17:00'),
                (6, true, '09:00', '15:00')
            `);
            console.log('Default business hours inserted (Mon-Sat, Closed Sunday)');
        }

        // Blocked dates table (for admin to block specific dates)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS blocked_dates (
                id SERIAL PRIMARY KEY,
                date DATE NOT NULL UNIQUE,
                reason VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('Blocked dates table ready');

    } catch (error) {
        console.error('Error creating tables:', error);
    }
};

createTables();

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, '../gallery');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|mp4|mov|avi|webm/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);

        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only images and videos are allowed!'));
        }
    }
});

// Session store (simple in-memory for now)
const sessions = new Map();

// Middleware to check authentication
const isAuthenticated = (req, res, next) => {
    const sessionId = req.cookies.admin_session;
    if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        if (Date.now() < session.expiresAt) {
            return next();
        } else {
            sessions.delete(sessionId);
        }
    }
    res.status(401).json({ error: 'Not authenticated' });
};

// Routes

// Login endpoint
app.post('/api/admin/login', async (req, res) => {
    const { password } = req.body;

    // For initial setup, password is "admin123" - change this!
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

    try {
        // Check if password hash exists, otherwise compare plain text (for initial setup)
        let isValid = false;
        if (process.env.ADMIN_PASSWORD_HASH && process.env.ADMIN_PASSWORD_HASH !== '$2b$10$YourHashWillGoHere') {
            isValid = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);
        } else {
            isValid = (password === ADMIN_PASSWORD);
        }

        if (isValid) {
            const sessionId = Math.random().toString(36).substring(2) + Date.now().toString(36);
            const expiresAt = Date.now() + (24 * 60 * 60 * 1000); // 24 hours

            sessions.set(sessionId, {
                createdAt: Date.now(),
                expiresAt: expiresAt
            });

            res.cookie('admin_session', sessionId, {
                httpOnly: true,
                maxAge: 24 * 60 * 60 * 1000,
                sameSite: 'strict'
            });

            res.json({ success: true, message: 'Login successful' });
        } else {
            res.status(401).json({ error: 'Invalid password' });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Logout endpoint
app.post('/api/admin/logout', (req, res) => {
    const sessionId = req.cookies.admin_session;
    if (sessionId) {
        sessions.delete(sessionId);
    }
    res.clearCookie('admin_session');
    res.json({ success: true, message: 'Logged out' });
});

// Check auth status
app.get('/api/admin/check-auth', isAuthenticated, (req, res) => {
    res.json({ authenticated: true });
});

// Upload gallery item
app.post('/api/admin/gallery/upload', isAuthenticated, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }

        const { caption, category } = req.body;
        const fileType = req.file.mimetype.startsWith('video') ? 'video' : 'image';

        const result = await pool.query(
            `INSERT INTO gallery_items (filename, original_name, file_type, file_size, caption, category)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [req.file.filename, req.file.originalname, fileType, req.file.size, caption || '', category || 'general']
        );

        res.json({
            success: true,
            message: 'File uploaded successfully',
            file: result.rows[0]
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// Get all gallery items
app.get('/api/gallery', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM gallery_items ORDER BY display_order ASC, created_at DESC'
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching gallery:', error);
        res.status(500).json({ error: 'Failed to fetch gallery items' });
    }
});

// Delete gallery item
app.delete('/api/admin/gallery/:id', isAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;

        // Get file info
        const fileResult = await pool.query('SELECT filename FROM gallery_items WHERE id = $1', [id]);
        if (fileResult.rows.length === 0) {
            return res.status(404).json({ error: 'File not found' });
        }

        const filename = fileResult.rows[0].filename;
        const filePath = path.join(__dirname, '../gallery', filename);

        // Delete from filesystem
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        // Delete from database
        await pool.query('DELETE FROM gallery_items WHERE id = $1', [id]);

        res.json({ success: true, message: 'File deleted successfully' });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ error: 'Delete failed' });
    }
});

// Serve gallery files
app.use('/gallery', express.static(path.join(__dirname, '../gallery')));

// Serve admin pages
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, '../admin/login.html'));
});

app.get('/admin/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, '../admin/dashboard.html'));
});

// ============================================
// BOOKING SYSTEM API ENDPOINTS
// ============================================

// Get all active services
app.get('/api/services', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM services WHERE is_active = true ORDER BY display_order ASC'
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching services:', error);
        res.status(500).json({ error: 'Failed to fetch services' });
    }
});

// Get business hours
app.get('/api/business-hours', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM business_hours ORDER BY day_of_week ASC'
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching business hours:', error);
        res.status(500).json({ error: 'Failed to fetch business hours' });
    }
});

// Get available time slots for a specific date
app.get('/api/availability/:date', async (req, res) => {
    try {
        const { date } = req.params;
        const requestedDate = new Date(date);
        const dayOfWeek = requestedDate.getDay();

        // Check if date is blocked
        const blockedCheck = await pool.query(
            'SELECT * FROM blocked_dates WHERE date = $1',
            [date]
        );

        if (blockedCheck.rows.length > 0) {
            return res.json({ available: false, reason: blockedCheck.rows[0].reason || 'Date unavailable' });
        }

        // Get business hours for this day
        const hoursResult = await pool.query(
            'SELECT * FROM business_hours WHERE day_of_week = $1',
            [dayOfWeek]
        );

        if (hoursResult.rows.length === 0 || !hoursResult.rows[0].is_open) {
            return res.json({ available: false, reason: 'Closed on this day' });
        }

        const { open_time, close_time } = hoursResult.rows[0];

        // Get existing bookings for this date
        const bookingsResult = await pool.query(
            'SELECT booking_time, total_duration FROM bookings WHERE booking_date = $1 AND status != $2',
            [date, 'cancelled']
        );

        // Generate time slots (every 30 minutes)
        const slots = [];
        const openHour = parseInt(open_time.split(':')[0]);
        const openMinute = parseInt(open_time.split(':')[1]);
        const closeHour = parseInt(close_time.split(':')[0]);
        const closeMinute = parseInt(close_time.split(':')[1]);

        for (let hour = openHour; hour < closeHour; hour++) {
            for (let minute = 0; minute < 60; minute += 30) {
                if (hour === openHour && minute < openMinute) continue;
                if (hour === closeHour - 1 && minute >= closeMinute) break;

                const timeSlot = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

                // Check if this slot overlaps with any existing booking
                let isAvailable = true;
                for (const booking of bookingsResult.rows) {
                    const bookingTime = booking.booking_time;
                    const bookingDuration = booking.total_duration;
                    // Simple overlap check - you may want to make this more sophisticated
                    if (timeSlot === bookingTime) {
                        isAvailable = false;
                        break;
                    }
                }

                slots.push({ time: timeSlot, available: isAvailable });
            }
        }

        res.json({
            available: true,
            date: date,
            slots: slots
        });
    } catch (error) {
        console.error('Error checking availability:', error);
        res.status(500).json({ error: 'Failed to check availability' });
    }
});

// Create a new booking
app.post('/api/bookings', async (req, res) => {
    try {
        const {
            customer_name,
            customer_email,
            customer_phone,
            service_ids,
            booking_date,
            booking_time,
            payment_method,
            notes
        } = req.body;

        // Validate required fields
        if (!customer_name || !customer_email || !customer_phone || !service_ids || !booking_date || !booking_time) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Get service details to calculate total duration and price
        const servicesResult = await pool.query(
            'SELECT * FROM services WHERE id = ANY($1)',
            [service_ids]
        );

        if (servicesResult.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid service selection' });
        }

        const total_duration = servicesResult.rows.reduce((sum, service) => sum + service.duration_minutes, 0);
        const total_price = servicesResult.rows.reduce((sum, service) => sum + parseFloat(service.price || 0), 0);

        // Check if time slot is still available
        const conflictCheck = await pool.query(
            'SELECT * FROM bookings WHERE booking_date = $1 AND booking_time = $2 AND status != $3',
            [booking_date, booking_time, 'cancelled']
        );

        if (conflictCheck.rows.length > 0) {
            return res.status(409).json({ error: 'Time slot no longer available' });
        }

        // Create booking
        const result = await pool.query(
            `INSERT INTO bookings
            (customer_name, customer_email, customer_phone, service_ids, booking_date, booking_time,
             total_duration, total_price, payment_method, notes)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *`,
            [customer_name, customer_email, customer_phone, service_ids, booking_date, booking_time,
             total_duration, total_price, payment_method || 'cash', notes || '']
        );

        const booking = result.rows[0];

        // TODO: Send email notifications here
        // TODO: Send WhatsApp/Telegram notification here

        res.json({
            success: true,
            message: 'Booking created successfully',
            booking: booking
        });
    } catch (error) {
        console.error('Error creating booking:', error);
        res.status(500).json({ error: 'Failed to create booking' });
    }
});

// Admin: Get all bookings
app.get('/api/admin/bookings', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM bookings ORDER BY booking_date DESC, booking_time DESC'
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching bookings:', error);
        res.status(500).json({ error: 'Failed to fetch bookings' });
    }
});

// Admin: Update booking status
app.patch('/api/admin/bookings/:id', isAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const { status, payment_status } = req.body;

        const updates = [];
        const values = [];
        let paramCount = 1;

        if (status) {
            updates.push(`status = $${paramCount++}`);
            values.push(status);
        }
        if (payment_status) {
            updates.push(`payment_status = $${paramCount++}`);
            values.push(payment_status);
        }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No updates provided' });
        }

        updates.push(`updated_at = CURRENT_TIMESTAMP`);
        values.push(id);

        const result = await pool.query(
            `UPDATE bookings SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`,
            values
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        res.json({
            success: true,
            message: 'Booking updated successfully',
            booking: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating booking:', error);
        res.status(500).json({ error: 'Failed to update booking' });
    }
});

// Admin: Delete booking
app.delete('/api/admin/bookings/:id', isAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM bookings WHERE id = $1 RETURNING *', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Booking not found' });
        }

        res.json({ success: true, message: 'Booking deleted successfully' });
    } catch (error) {
        console.error('Error deleting booking:', error);
        res.status(500).json({ error: 'Failed to delete booking' });
    }
});

// Admin: Update business hours
app.put('/api/admin/business-hours/:day', isAuthenticated, async (req, res) => {
    try {
        const { day } = req.params;
        const { is_open, open_time, close_time } = req.body;

        const result = await pool.query(
            `UPDATE business_hours
            SET is_open = $1, open_time = $2, close_time = $3, updated_at = CURRENT_TIMESTAMP
            WHERE day_of_week = $4
            RETURNING *`,
            [is_open, open_time, close_time, day]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Business hours not found' });
        }

        res.json({
            success: true,
            message: 'Business hours updated',
            hours: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating business hours:', error);
        res.status(500).json({ error: 'Failed to update business hours' });
    }
});

// Admin: Block a date
app.post('/api/admin/blocked-dates', isAuthenticated, async (req, res) => {
    try {
        const { date, reason } = req.body;

        if (!date) {
            return res.status(400).json({ error: 'Date is required' });
        }

        const result = await pool.query(
            'INSERT INTO blocked_dates (date, reason) VALUES ($1, $2) RETURNING *',
            [date, reason || 'Unavailable']
        );

        res.json({
            success: true,
            message: 'Date blocked successfully',
            blocked_date: result.rows[0]
        });
    } catch (error) {
        if (error.code === '23505') { // Unique violation
            return res.status(409).json({ error: 'Date already blocked' });
        }
        console.error('Error blocking date:', error);
        res.status(500).json({ error: 'Failed to block date' });
    }
});

// Admin: Unblock a date
app.delete('/api/admin/blocked-dates/:date', isAuthenticated, async (req, res) => {
    try {
        const { date } = req.params;
        const result = await pool.query('DELETE FROM blocked_dates WHERE date = $1 RETURNING *', [date]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Blocked date not found' });
        }

        res.json({ success: true, message: 'Date unblocked successfully' });
    } catch (error) {
        console.error('Error unblocking date:', error);
        res.status(500).json({ error: 'Failed to unblock date' });
    }
});

// Admin: Get all services (including inactive)
app.get('/api/admin/services', isAuthenticated, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM services ORDER BY display_order ASC');
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching services:', error);
        res.status(500).json({ error: 'Failed to fetch services' });
    }
});

// Admin: Create service
app.post('/api/admin/services', isAuthenticated, async (req, res) => {
    try {
        const { name, description, duration_minutes, price, show_price } = req.body;

        if (!name || !duration_minutes) {
            return res.status(400).json({ error: 'Name and duration are required' });
        }

        const result = await pool.query(
            `INSERT INTO services (name, description, duration_minutes, price, show_price)
            VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [name, description || '', duration_minutes, price || null, show_price !== false]
        );

        res.json({
            success: true,
            message: 'Service created successfully',
            service: result.rows[0]
        });
    } catch (error) {
        console.error('Error creating service:', error);
        res.status(500).json({ error: 'Failed to create service' });
    }
});

// Admin: Update service
app.put('/api/admin/services/:id', isAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, duration_minutes, price, show_price, is_active } = req.body;

        const result = await pool.query(
            `UPDATE services
            SET name = COALESCE($1, name),
                description = COALESCE($2, description),
                duration_minutes = COALESCE($3, duration_minutes),
                price = COALESCE($4, price),
                show_price = COALESCE($5, show_price),
                is_active = COALESCE($6, is_active),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $7
            RETURNING *`,
            [name, description, duration_minutes, price, show_price, is_active, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Service not found' });
        }

        res.json({
            success: true,
            message: 'Service updated successfully',
            service: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating service:', error);
        res.status(500).json({ error: 'Failed to update service' });
    }
});

// Admin: Delete service
app.delete('/api/admin/services/:id', isAuthenticated, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM services WHERE id = $1 RETURNING *', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Service not found' });
        }

        res.json({ success: true, message: 'Service deleted successfully' });
    } catch (error) {
        console.error('Error deleting service:', error);
        res.status(500).json({ error: 'Failed to delete service' });
    }
});

// ============================================
// AI BUSINESS ASSISTANT
// ============================================

// Helper function to get business data context
async function getBusinessContext() {
    try {
        const today = new Date().toISOString().split('T')[0];
        const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const oneMonthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        // Get all services
        const servicesResult = await pool.query('SELECT * FROM services ORDER BY display_order ASC');

        // Get bookings stats
        const totalBookingsResult = await pool.query('SELECT COUNT(*) as count FROM bookings');
        const todayBookingsResult = await pool.query(
            'SELECT COUNT(*) as count FROM bookings WHERE booking_date = $1',
            [today]
        );
        const weekBookingsResult = await pool.query(
            'SELECT COUNT(*) as count FROM bookings WHERE booking_date >= $1',
            [oneWeekAgo]
        );
        const monthBookingsResult = await pool.query(
            'SELECT COUNT(*) as count FROM bookings WHERE booking_date >= $1',
            [oneMonthAgo]
        );
        const lastMonthBookingsResult = await pool.query(
            'SELECT COUNT(*) as count FROM bookings WHERE booking_date >= $1 AND booking_date < $2',
            [twoMonthsAgo, oneMonthAgo]
        );
        const yearBookingsResult = await pool.query(
            'SELECT COUNT(*) as count FROM bookings WHERE booking_date >= $1',
            [oneYearAgo]
        );

        // Get revenue stats
        const totalRevenueResult = await pool.query(
            'SELECT SUM(total_price) as revenue FROM bookings WHERE status != $1',
            ['cancelled']
        );
        const monthRevenueResult = await pool.query(
            'SELECT SUM(total_price) as revenue FROM bookings WHERE booking_date >= $1 AND status != $2',
            [oneMonthAgo, 'cancelled']
        );
        const lastMonthRevenueResult = await pool.query(
            'SELECT SUM(total_price) as revenue FROM bookings WHERE booking_date >= $1 AND booking_date < $2 AND status != $3',
            [twoMonthsAgo, oneMonthAgo, 'cancelled']
        );
        const yearRevenueResult = await pool.query(
            'SELECT SUM(total_price) as revenue FROM bookings WHERE booking_date >= $1 AND status != $2',
            [oneYearAgo, 'cancelled']
        );

        // Get service popularity
        const servicePopularityResult = await pool.query(`
            SELECT s.name, s.id, s.price, COUNT(b.id) as booking_count,
                   SUM(CASE WHEN b.status != 'cancelled' THEN s.price ELSE 0 END) as total_revenue
            FROM services s
            LEFT JOIN bookings b ON s.id = ANY(b.service_ids)
            WHERE b.status != 'cancelled' OR b.status IS NULL
            GROUP BY s.id, s.name, s.price
            ORDER BY booking_count DESC
        `);

        // Get upcoming bookings
        const upcomingBookingsResult = await pool.query(
            'SELECT * FROM bookings WHERE booking_date >= $1 AND status = $2 ORDER BY booking_date ASC, booking_time ASC LIMIT 10',
            [today, 'confirmed']
        );

        // Get payment status
        const pendingPaymentsResult = await pool.query(
            'SELECT COUNT(*) as count, SUM(total_price) as amount FROM bookings WHERE payment_status = $1 AND status != $2',
            ['pending', 'cancelled']
        );

        // Get repeat customers
        const repeatCustomersResult = await pool.query(`
            SELECT customer_email, customer_name, COUNT(*) as booking_count,
                   SUM(total_price) as total_spent,
                   MAX(booking_date) as last_booking
            FROM bookings
            WHERE status != 'cancelled'
            GROUP BY customer_email, customer_name
            HAVING COUNT(*) > 1
            ORDER BY booking_count DESC
            LIMIT 20
        `);

        // Get all customers with history
        const allCustomersResult = await pool.query(`
            SELECT customer_email, customer_name, customer_phone,
                   COUNT(*) as booking_count,
                   SUM(total_price) as total_spent,
                   MIN(booking_date) as first_booking,
                   MAX(booking_date) as last_booking,
                   ARRAY_AGG(booking_date ORDER BY booking_date DESC) as booking_dates
            FROM bookings
            WHERE status != 'cancelled'
            GROUP BY customer_email, customer_name, customer_phone
            ORDER BY last_booking DESC
        `);

        // Get booking trends by day of week
        const dayOfWeekTrendsResult = await pool.query(`
            SELECT EXTRACT(DOW FROM booking_date) as day_of_week,
                   COUNT(*) as booking_count
            FROM bookings
            WHERE booking_date >= $1 AND status != 'cancelled'
            GROUP BY day_of_week
            ORDER BY booking_count DESC
        `, [oneMonthAgo]);

        const monthBookings = parseInt(monthBookingsResult.rows[0].count);
        const lastMonthBookings = parseInt(lastMonthBookingsResult.rows[0].count);
        const monthRevenue = parseFloat(monthRevenueResult.rows[0].revenue || 0);
        const lastMonthRevenue = parseFloat(lastMonthRevenueResult.rows[0].revenue || 0);

        return {
            current_date: today,
            services: servicesResult.rows,
            statistics: {
                total_bookings: parseInt(totalBookingsResult.rows[0].count),
                today_bookings: parseInt(todayBookingsResult.rows[0].count),
                week_bookings: parseInt(weekBookingsResult.rows[0].count),
                month_bookings: monthBookings,
                last_month_bookings: lastMonthBookings,
                booking_growth: lastMonthBookings > 0 ? ((monthBookings - lastMonthBookings) / lastMonthBookings * 100).toFixed(1) : 0,
                year_bookings: parseInt(yearBookingsResult.rows[0].count),
                total_revenue: parseFloat(totalRevenueResult.rows[0].revenue || 0),
                month_revenue: monthRevenue,
                last_month_revenue: lastMonthRevenue,
                revenue_growth: lastMonthRevenue > 0 ? ((monthRevenue - lastMonthRevenue) / lastMonthRevenue * 100).toFixed(1) : 0,
                year_revenue: parseFloat(yearRevenueResult.rows[0].revenue || 0),
                pending_payments_count: parseInt(pendingPaymentsResult.rows[0].count),
                pending_payments_amount: parseFloat(pendingPaymentsResult.rows[0].amount || 0),
                repeat_customer_count: repeatCustomersResult.rows.length,
                total_customer_count: allCustomersResult.rows.length
            },
            service_popularity: servicePopularityResult.rows,
            upcoming_bookings: upcomingBookingsResult.rows.map(b => ({
                date: b.booking_date,
                time: b.booking_time,
                customer: b.customer_name,
                price: parseFloat(b.total_price)
            })),
            repeat_customers: repeatCustomersResult.rows,
            all_customers: allCustomersResult.rows,
            day_of_week_trends: dayOfWeekTrendsResult.rows
        };
    } catch (error) {
        console.error('Error getting business context:', error);
        return null;
    }
}

// AI Assistant endpoint
app.post('/api/admin/ai-assistant', isAuthenticated, async (req, res) => {
    try {
        const { question } = req.body;

        if (!question) {
            return res.status(400).json({ error: 'Question is required' });
        }

        // Get business context
        const context = await getBusinessContext();

        if (!context) {
            return res.status(500).json({ error: 'Failed to get business context' });
        }

        // Build prompt with context and action capabilities
        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const busiestDay = context.day_of_week_trends.length > 0
            ? dayNames[parseInt(context.day_of_week_trends[0].day_of_week)]
            : 'N/A';

        const prompt = `You are an AI business assistant and strategic advisor for Fluid Detailing, an auto detailing business.
You have access to comprehensive business data and can provide insights, recommendations, and execute actions.

CURRENT DATE: ${context.current_date}

SERVICES OFFERED:
${context.services.map(s => `- ${s.name} (ID: ${s.id}): $${s.price} (${s.duration_minutes} min)${s.is_active ? '' : ' [INACTIVE]'}`).join('\n')}

BOOKING STATISTICS & TRENDS:
- Total bookings (all time): ${context.statistics.total_bookings}
- Bookings today: ${context.statistics.today_bookings}
- Bookings this week: ${context.statistics.week_bookings}
- Bookings this month: ${context.statistics.month_bookings}
- Last month bookings: ${context.statistics.last_month_bookings}
- Booking growth: ${context.statistics.booking_growth}% (month-over-month)
- Bookings this year: ${context.statistics.year_bookings}
- Busiest day of week: ${busiestDay}

REVENUE & FINANCIAL:
- Total revenue (all time): $${context.statistics.total_revenue.toFixed(2)}
- Revenue this month: $${context.statistics.month_revenue.toFixed(2)}
- Last month revenue: $${context.statistics.last_month_revenue.toFixed(2)}
- Revenue growth: ${context.statistics.revenue_growth}% (month-over-month)
- Revenue this year: $${context.statistics.year_revenue.toFixed(2)}
- Average revenue per booking: $${(context.statistics.total_revenue / context.statistics.total_bookings || 0).toFixed(2)}
- Pending payments: ${context.statistics.pending_payments_count} bookings ($${context.statistics.pending_payments_amount.toFixed(2)})

CUSTOMER INSIGHTS:
- Total customers: ${context.statistics.total_customer_count}
- Repeat customers: ${context.statistics.repeat_customer_count}
- Customer retention rate: ${context.statistics.total_customer_count > 0 ? ((context.statistics.repeat_customer_count / context.statistics.total_customer_count) * 100).toFixed(1) : 0}%
- Top 3 repeat customers: ${context.repeat_customers.slice(0, 3).map(c => `${c.customer_name} (${c.booking_count} bookings, $${parseFloat(c.total_spent).toFixed(2)})`).join(', ')}

SERVICE PERFORMANCE:
${context.service_popularity.map((s, i) => `${i+1}. ${s.name}: ${s.booking_count} bookings, $${parseFloat(s.total_revenue || 0).toFixed(2)} revenue`).join('\n')}

UPCOMING BOOKINGS (next 10):
${context.upcoming_bookings.length > 0 ? context.upcoming_bookings.map(b => `- ${b.date} at ${b.time}: ${b.customer} ($${b.price})`).join('\n') : 'No upcoming bookings'}

The business owner is asking you: "${question}"

CAPABILITIES:
1. BUSINESS INSIGHTS: Analyze data and provide strategic recommendations for growth, pricing, marketing, etc.
2. CUSTOMER HISTORY: View specific customer booking history and spending patterns
3. MARKETING: Generate newsletters and promotional content
4. ACTIONS: Block dates, update prices, generate reports

If the user requests an action, respond with ONLY a JSON object:
{"action": "ACTION_TYPE", "params": {...}}

Available actions:
1. Block date: {"action": "BLOCK_DATE", "params": {"date": "YYYY-MM-DD", "reason": "text"}}
2. Update service price: {"action": "UPDATE_SERVICE_PRICE", "params": {"service_id": NUMBER, "price": NUMBER}}
3. Generate report: {"action": "GENERATE_REPORT", "params": {"type": "revenue|bookings|services|customers"}}
4. View customer history: {"action": "VIEW_CUSTOMER", "params": {"email": "customer@email.com"}}
5. Generate newsletter: {"action": "GENERATE_NEWSLETTER", "params": {"topic": "description", "promotion": "optional promo details"}}

For business insights/recommendations, analyze the data and provide:
- Specific, actionable suggestions based on trends
- Identify opportunities (underperforming services, pricing adjustments, etc.)
- Marketing strategies based on customer behavior
- Revenue optimization ideas

Be professional, data-driven, and strategic. Format currency as CAD dollars.`;

        // Call Gemini CLI
        const { stdout, stderr } = await execPromise(`GEMINI_API_KEY="${process.env.GEMINI_API_KEY}" gemini "${prompt.replace(/"/g, '\\"')}"`);

        if (stderr) {
            console.error('Gemini stderr:', stderr);
        }

        let answer = stdout.trim();
        let actionExecuted = false;
        let actionResult = null;

        // Check if response is an action request
        try {
            const actionMatch = answer.match(/\{.*"action".*\}/s);
            if (actionMatch) {
                const actionRequest = JSON.parse(actionMatch[0]);

                // Execute the action
                switch (actionRequest.action) {
                    case 'BLOCK_DATE':
                        actionResult = await executeBlockDate(actionRequest.params);
                        answer = `✅ I've blocked ${actionRequest.params.date} for you. Reason: ${actionRequest.params.reason}. This date is now unavailable for bookings.`;
                        actionExecuted = true;
                        break;

                    case 'UPDATE_SERVICE_PRICE':
                        actionResult = await executeUpdateServicePrice(actionRequest.params);
                        const service = context.services.find(s => s.id === actionRequest.params.service_id);
                        answer = `✅ I've updated the price for "${service?.name}" to $${actionRequest.params.price}. The change is now live on your booking page.`;
                        actionExecuted = true;
                        break;

                    case 'GENERATE_REPORT':
                        actionResult = await executeGenerateReport(actionRequest.params, context);
                        answer = `✅ I've generated a ${actionRequest.params.type} report. You can download it using the link provided.`;
                        actionExecuted = true;
                        break;

                    case 'VIEW_CUSTOMER':
                        actionResult = await executeViewCustomer(actionRequest.params, context);
                        const customer = actionResult.customer;
                        if (customer) {
                            answer = `📊 Customer History for ${customer.customer_name}:
- Total bookings: ${customer.booking_count}
- Total spent: $${parseFloat(customer.total_spent).toFixed(2)}
- First booking: ${customer.first_booking}
- Last booking: ${customer.last_booking}
- Email: ${customer.customer_email}
- Phone: ${customer.customer_phone}
- Recent booking dates: ${customer.booking_dates.slice(0, 5).join(', ')}`;
                        } else {
                            answer = `❌ Customer not found with email: ${actionRequest.params.email}`;
                        }
                        actionExecuted = true;
                        break;

                    case 'GENERATE_NEWSLETTER':
                        actionResult = await executeGenerateNewsletter(actionRequest.params, context);
                        answer = `✅ I've generated a newsletter for you! The HTML email is ready to send. Check the download link below.`;
                        actionExecuted = true;
                        break;
                }
            }
        } catch (parseError) {
            // Not an action, continue with regular answer
        }

        res.json({
            success: true,
            question: question,
            answer: answer,
            actionExecuted: actionExecuted,
            actionResult: actionResult,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('AI Assistant error:', error);
        res.status(500).json({
            error: 'Failed to get AI response',
            details: error.message
        });
    }
});

// Action execution functions
async function executeBlockDate(params) {
    try {
        const result = await pool.query(
            'INSERT INTO blocked_dates (date, reason) VALUES ($1, $2) RETURNING *',
            [params.date, params.reason || 'Blocked via AI Assistant']
        );
        return { success: true, blocked_date: result.rows[0] };
    } catch (error) {
        if (error.code === '23505') {
            return { success: false, error: 'Date already blocked' };
        }
        throw error;
    }
}

async function executeUpdateServicePrice(params) {
    try {
        const result = await pool.query(
            'UPDATE services SET price = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *',
            [params.price, params.service_id]
        );
        return { success: true, service: result.rows[0] };
    } catch (error) {
        throw error;
    }
}

async function executeGenerateReport(params, context) {
    // Generate CSV data based on report type
    let csvData = '';

    switch (params.type) {
        case 'revenue':
            csvData = 'Period,Revenue\n';
            csvData += `Total (All Time),$${context.statistics.total_revenue.toFixed(2)}\n`;
            csvData += `This Month,$${context.statistics.month_revenue.toFixed(2)}\n`;
            csvData += `This Year,$${context.statistics.year_revenue.toFixed(2)}\n`;
            break;

        case 'bookings':
            csvData = 'Period,Count\n';
            csvData += `Total (All Time),${context.statistics.total_bookings}\n`;
            csvData += `Today,${context.statistics.today_bookings}\n`;
            csvData += `This Week,${context.statistics.week_bookings}\n`;
            csvData += `This Month,${context.statistics.month_bookings}\n`;
            csvData += `This Year,${context.statistics.year_bookings}\n`;
            break;

        case 'services':
            csvData = 'Service Name,Booking Count,Price,Duration (min),Total Revenue\n';
            context.service_popularity.forEach(s => {
                const service = context.services.find(srv => srv.name === s.name);
                csvData += `"${s.name}",${s.booking_count},$${service?.price || 0},${service?.duration_minutes || 0},$${parseFloat(s.total_revenue || 0).toFixed(2)}\n`;
            });
            break;

        case 'customers':
            csvData = 'Customer Name,Email,Phone,Total Bookings,Total Spent,First Booking,Last Booking\n';
            context.all_customers.forEach(c => {
                csvData += `"${c.customer_name}","${c.customer_email}","${c.customer_phone}",${c.booking_count},$${parseFloat(c.total_spent).toFixed(2)},${c.first_booking},${c.last_booking}\n`;
            });
            break;
    }

    return {
        success: true,
        reportType: params.type,
        csvData: csvData,
        downloadUrl: `/api/admin/download-report?data=${encodeURIComponent(csvData)}&filename=${params.type}_report_${Date.now()}.csv`
    };
}

async function executeViewCustomer(params, context) {
    const customer = context.all_customers.find(c =>
        c.customer_email.toLowerCase() === params.email.toLowerCase()
    );

    return {
        success: customer ? true : false,
        customer: customer || null
    };
}

async function executeGenerateNewsletter(params, context) {
    // Generate newsletter content using AI
    const newsletterPrompt = `Create a professional HTML email newsletter for Fluid Detailing auto detailing business.

Topic: ${params.topic}
${params.promotion ? `Special Promotion: ${params.promotion}` : ''}

Services offered:
${context.services.filter(s => s.is_active).map(s => `- ${s.name}: $${s.price}`).join('\n')}

Create an engaging HTML email with:
- Eye-catching subject line
- Professional header with business name
- Brief intro paragraph
- Highlight the promotion/topic
- Call-to-action button to book
- Footer with contact info

Use these colors:
- Primary: #CC0000 (red)
- Dark: #1a1a1a (dark grey)
- Light: #b8b8b8 (light grey)

Respond with ONLY the complete HTML code, no explanations.`;

    try {
        const { stdout } = await execPromise(`GEMINI_API_KEY="${process.env.GEMINI_API_KEY}" gemini "${newsletterPrompt.replace(/"/g, '\\"')}"`);

        let htmlContent = stdout.trim();

        // Remove markdown code blocks if present
        htmlContent = htmlContent.replace(/```html\n?/g, '').replace(/```\n?/g, '');

        // If HTML doesn't contain DOCTYPE, add a basic structure
        if (!htmlContent.includes('<!DOCTYPE') && !htmlContent.includes('<html')) {
            htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fluid Detailing Newsletter</title>
</head>
<body>
${htmlContent}
</body>
</html>`;
        }

        return {
            success: true,
            newsletterContent: htmlContent,
            downloadUrl: `/api/admin/download-report?data=${encodeURIComponent(htmlContent)}&filename=newsletter_${Date.now()}.html`
        };
    } catch (error) {
        console.error('Newsletter generation error:', error);
        return {
            success: false,
            error: 'Failed to generate newsletter'
        };
    }
}

// Report download endpoint
app.get('/api/admin/download-report', isAuthenticated, (req, res) => {
    const { data, filename } = req.query;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(decodeURIComponent(data));
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Admin panel: http://localhost:${PORT}/admin`);
});

// Cleanup old sessions every hour
setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions.entries()) {
        if (now > session.expiresAt) {
            sessions.delete(sessionId);
        }
    }
}, 60 * 60 * 1000);
