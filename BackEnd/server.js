const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========================================
// CONFIGURACIÓN DE BASE DE DATOS
// ========================================

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'cegae_db',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

// ========================================
// SCRIPTS SQL PARA CREAR TABLAS
// ========================================

const createTablesSQL = `
-- Tabla de estados
CREATE TABLE IF NOT EXISTS cegae_estados (
    idestado SERIAL PRIMARY KEY,
    nombre VARCHAR(50) NOT NULL,
    descripcion VARCHAR(200),
    fechacreacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabla de cursos disponibles
CREATE TABLE IF NOT EXISTS cegae_cursosdisponibles (
    idcurso SERIAL PRIMARY KEY,
    nombre_curso VARCHAR(255) NOT NULL,
    descripcion TEXT,
    dirigido TEXT,
    horas_clases_por_dia VARCHAR(100),
    horarios TEXT,
    frecuencia TEXT,
    idestado INT4,
    fechacreacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fechaedicion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fechaanulacion TIMESTAMP,
    CONSTRAINT fk_curso_estado FOREIGN KEY (idestado) 
        REFERENCES cegae_estados(idestado)
);

-- Tabla de ciclos de cursos
CREATE TABLE IF NOT EXISTS cegae_cursosdisponiblesciclo (
    idciclo SERIAL PRIMARY KEY,
    idcurso INT4 NOT NULL,
    nombreciclo VARCHAR(255) NOT NULL,
    precio_regular NUMERIC(10,2),
    precio_promocion NUMERIC(10,2),
    fecha_inicio_clase DATE,
    fecha_fin_clase DATE,
    duracion_curso_total VARCHAR(100),
    idestado INT4,
    fechacreacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fechaedicion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    fechaanulacion TIMESTAMP,
    CONSTRAINT fk_ciclo_curso FOREIGN KEY (idcurso) 
        REFERENCES cegae_cursosdisponibles(idcurso) ON DELETE CASCADE,
    CONSTRAINT fk_ciclo_estado FOREIGN KEY (idestado) 
        REFERENCES cegae_estados(idestado)
);

-- Insertar estados iniciales si no existen
INSERT INTO cegae_estados (nombre, descripcion) 
SELECT * FROM (VALUES 
    ('Activo', 'Registro activo y disponible'),
    ('Inactivo', 'Registro inactivo temporalmente'),
    ('Anulado', 'Registro anulado permanentemente'),
    ('Pendiente', 'Registro pendiente de aprobación'),
    ('Finalizado', 'Registro finalizado')
) AS v(nombre, descripcion)
WHERE NOT EXISTS (SELECT 1 FROM cegae_estados);

-- Crear índices para mejorar performance
CREATE INDEX IF NOT EXISTS idx_curso_estado ON cegae_cursosdisponibles(idestado);
CREATE INDEX IF NOT EXISTS idx_curso_nombre ON cegae_cursosdisponibles(nombre_curso);
CREATE INDEX IF NOT EXISTS idx_ciclo_curso ON cegae_cursosdisponiblesciclo(idcurso);
CREATE INDEX IF NOT EXISTS idx_ciclo_estado ON cegae_cursosdisponiblesciclo(idestado);
CREATE INDEX IF NOT EXISTS idx_ciclo_fechas ON cegae_cursosdisponiblesciclo(fecha_inicio_clase, fecha_fin_clase);
`;

// Inicializar base de datos
async function initDatabase() {
    try {
        await pool.query(createTablesSQL);
        console.log('✅ Tablas creadas/verificadas exitosamente');
    } catch (error) {
        console.error('❌ Error al crear tablas:', error);
    }
}

// ========================================
// MIDDLEWARE DE AUTENTICACIÓN
// ========================================

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Token no proporcionado' });
    }

    jwt.verify(token, process.env.JWT_SECRET || 'tu_secret_key_aqui', (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token inválido' });
        }
        req.user = user;
        next();
    });
};

// ========================================
// RUTAS DE AUTENTICACIÓN
// ========================================

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // Verificar credenciales desde variables de entorno
        const ADMIN_USER = process.env.ADMIN_USER || 'admin';
        const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
        
        if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
            return res.status(401).json({ error: 'Credenciales inválidas' });
        }
        
        // Generar token JWT
        const token = jwt.sign(
            { username, role: 'admin' },
            process.env.JWT_SECRET || 'tu_secret_key_aqui',
            { expiresIn: '24h' }
        );
        
        res.json({ 
            token, 
            user: { username, role: 'admin' },
            message: 'Login exitoso' 
        });
    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ error: 'Error en el servidor' });
    }
});

// Verificar token
app.get('/api/auth/verify', authenticateToken, (req, res) => {
    res.json({ valid: true, user: req.user });
});

// ========================================
// RUTAS PARA ESTADOS
// ========================================

// Obtener todos los estados
app.get('/api/estados', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM cegae_estados ORDER BY idestado'
        );
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener estados:', error);
        res.status(500).json({ error: 'Error al obtener estados' });
    }
});

// ========================================
// RUTAS PARA CURSOS
// ========================================

// Obtener todos los cursos
app.get('/api/cursos', authenticateToken, async (req, res) => {
    try {
        const { search, estado } = req.query;
        let query = `
            SELECT c.*, e.nombre as estado_nombre 
            FROM cegae_cursosdisponibles c
            LEFT JOIN cegae_estados e ON c.idestado = e.idestado
            WHERE 1=1
        `;
        const params = [];
        
        if (search) {
            params.push(`%${search}%`);
            query += ` AND (c.nombre_curso ILIKE $${params.length} 
                       OR c.descripcion ILIKE $${params.length})`;
        }
        
        if (estado) {
            params.push(estado);
            query += ` AND c.idestado = $${params.length}`;
        }
        
        query += ' ORDER BY c.idcurso DESC';
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener cursos:', error);
        res.status(500).json({ error: 'Error al obtener cursos' });
    }
});

// Obtener un curso por ID
app.get('/api/cursos/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT c.*, e.nombre as estado_nombre 
             FROM cegae_cursosdisponibles c
             LEFT JOIN cegae_estados e ON c.idestado = e.idestado
             WHERE c.idcurso = $1`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Curso no encontrado' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error al obtener curso:', error);
        res.status(500).json({ error: 'Error al obtener curso' });
    }
});

// Crear nuevo curso
app.post('/api/cursos', authenticateToken, async (req, res) => {
    try {
        const {
            nombre_curso,
            descripcion,
            dirigido,
            horas_clases_por_dia,
            horarios,
            frecuencia,
            idestado
        } = req.body;
        
        // Validación básica
        if (!nombre_curso) {
            return res.status(400).json({ error: 'El nombre del curso es requerido' });
        }
        
        const result = await pool.query(
            `INSERT INTO cegae_cursosdisponibles 
             (nombre_curso, descripcion, dirigido, horas_clases_por_dia, 
              horarios, frecuencia, idestado)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [nombre_curso, descripcion, dirigido, horas_clases_por_dia, 
             horarios, frecuencia, idestado || 1]
        );
        
        res.status(201).json({
            message: 'Curso creado exitosamente',
            curso: result.rows[0]
        });
    } catch (error) {
        console.error('Error al crear curso:', error);
        res.status(500).json({ error: 'Error al crear curso' });
    }
});

// Actualizar curso
app.put('/api/cursos/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            nombre_curso,
            descripcion,
            dirigido,
            horas_clases_por_dia,
            horarios,
            frecuencia,
            idestado
        } = req.body;
        
        const result = await pool.query(
            `UPDATE cegae_cursosdisponibles 
             SET nombre_curso = $1, 
                 descripcion = $2, 
                 dirigido = $3, 
                 horas_clases_por_dia = $4,
                 horarios = $5, 
                 frecuencia = $6, 
                 idestado = $7,
                 fechaedicion = CURRENT_TIMESTAMP
             WHERE idcurso = $8
             RETURNING *`,
            [nombre_curso, descripcion, dirigido, horas_clases_por_dia, 
             horarios, frecuencia, idestado, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Curso no encontrado' });
        }
        
        res.json({
            message: 'Curso actualizado exitosamente',
            curso: result.rows[0]
        });
    } catch (error) {
        console.error('Error al actualizar curso:', error);
        res.status(500).json({ error: 'Error al actualizar curso' });
    }
});

// Eliminar curso (soft delete)
app.delete('/api/cursos/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Verificar si hay ciclos asociados
        const ciclosCheck = await pool.query(
            'SELECT COUNT(*) FROM cegae_cursosdisponiblesciclo WHERE idcurso = $1',
            [id]
        );
        
        if (parseInt(ciclosCheck.rows[0].count) > 0) {
            return res.status(400).json({ 
                error: 'No se puede eliminar el curso porque tiene ciclos asociados' 
            });
        }
        
        // Soft delete: marcar como anulado
        const result = await pool.query(
            `UPDATE cegae_cursosdisponibles 
             SET idestado = 3, 
                 fechaanulacion = CURRENT_TIMESTAMP 
             WHERE idcurso = $1
             RETURNING *`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Curso no encontrado' });
        }
        
        res.json({ message: 'Curso eliminado exitosamente' });
    } catch (error) {
        console.error('Error al eliminar curso:', error);
        res.status(500).json({ error: 'Error al eliminar curso' });
    }
});

// ========================================
// RUTAS PARA CICLOS
// ========================================

// Obtener todos los ciclos
app.get('/api/ciclos', authenticateToken, async (req, res) => {
    try {
        const { search, idcurso, estado } = req.query;
        let query = `
            SELECT ci.*, cu.nombre_curso, e.nombre as estado_nombre 
            FROM cegae_cursosdisponiblesciclo ci
            INNER JOIN cegae_cursosdisponibles cu ON ci.idcurso = cu.idcurso
            LEFT JOIN cegae_estados e ON ci.idestado = e.idestado
            WHERE 1=1 
        `;
        const params = [];
        
        if (search) {
            params.push(`%${search}%`);
            query += ` AND ci.nombreciclo ILIKE $${params.length}`;
        }
        
        if (idcurso) {
            params.push(idcurso);
            query += ` AND ci.idcurso = $${params.length}`;
        }
        
        if (estado) {
            params.push(estado);
            query += ` AND ci.idestado = $${params.length}`;
        }
        
        query += ' ORDER BY ci.idcurso DESC';
        
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (error) {
        console.error('Error al obtener ciclos:', error);
        res.status(500).json({ error: 'Error al obtener ciclos' });
    }
});

// Obtener un ciclo por ID
app.get('/api/ciclos/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query(
            `SELECT ci.*, cu.nombre_curso, e.nombre as estado_nombre 
             FROM cegae_cursosdisponiblesciclo ci
             INNER JOIN cegae_cursosdisponibles cu ON ci.idcurso = cu.idcurso
             LEFT JOIN cegae_estados e ON ci.idestado = e.idestado
             WHERE ci.idciclo = $1`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ciclo no encontrado' });
        }
        
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error al obtener ciclo:', error);
        res.status(500).json({ error: 'Error al obtener ciclo' });
    }
});

// Crear nuevo ciclo
app.post('/api/ciclos', authenticateToken, async (req, res) => {
    try {
        const {
            idcurso,
            nombreciclo,
            precio_regular,
            precio_promocion,
            fecha_inicio_clase,
            fecha_fin_clase,
            duracion_curso_total,
            idestado
        } = req.body;
        
        // Validación básica
        if (!idcurso || !nombreciclo) {
            return res.status(400).json({ 
                error: 'El curso y nombre del ciclo son requeridos' 
            });
        }
        
        // Verificar que el curso existe
        const cursoCheck = await pool.query(
            'SELECT idcurso FROM cegae_cursosdisponibles WHERE idcurso = $1',
            [idcurso]
        );
        
        if (cursoCheck.rows.length === 0) {
            return res.status(400).json({ error: 'El curso especificado no existe' });
        }
        
        const result = await pool.query(
            `INSERT INTO cegae_cursosdisponiblesciclo 
             (idcurso, nombreciclo, precio_regular, precio_promocion, 
              fecha_inicio_clase, fecha_fin_clase, duracion_curso_total, idestado)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [idcurso, nombreciclo, precio_regular, precio_promocion, 
             fecha_inicio_clase, fecha_fin_clase, duracion_curso_total, idestado || 1]
        );
        
        res.status(201).json({
            message: 'Ciclo creado exitosamente',
            ciclo: result.rows[0]
        });
    } catch (error) {
        console.error('Error al crear ciclo:', error);
        res.status(500).json({ error: 'Error al crear ciclo' });
    }
});

// Actualizar ciclo
app.put('/api/ciclos/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            idcurso,
            nombreciclo,
            precio_regular,
            precio_promocion,
            fecha_inicio_clase,
            fecha_fin_clase,
            duracion_curso_total,
            idestado
        } = req.body;
        
        const result = await pool.query(
            `UPDATE cegae_cursosdisponiblesciclo 
             SET idcurso = $1,
                 nombreciclo = $2,
                 precio_regular = $3,
                 precio_promocion = $4,
                 fecha_inicio_clase = $5,
                 fecha_fin_clase = $6,
                 duracion_curso_total = $7,
                 idestado = $8,
                 fechaedicion = CURRENT_TIMESTAMP
             WHERE idciclo = $9
             RETURNING *`,
            [idcurso, nombreciclo, precio_regular, precio_promocion, 
             fecha_inicio_clase, fecha_fin_clase, duracion_curso_total, 
             idestado, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ciclo no encontrado' });
        }
        
        res.json({
            message: 'Ciclo actualizado exitosamente',
            ciclo: result.rows[0]
        });
    } catch (error) {
        console.error('Error al actualizar ciclo:', error);
        res.status(500).json({ error: 'Error al actualizar ciclo' });
    }
});

// Eliminar ciclo (soft delete)
app.delete('/api/ciclos/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Soft delete: marcar como anulado
        const result = await pool.query(
            `UPDATE cegae_cursosdisponiblesciclo 
             SET idestado = 3, 
                 fechaanulacion = CURRENT_TIMESTAMP 
             WHERE idciclo = $1
             RETURNING *`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Ciclo no encontrado' });
        }
        
        res.json({ message: 'Ciclo eliminado exitosamente' });
    } catch (error) {
        console.error('Error al eliminar ciclo:', error);
        res.status(500).json({ error: 'Error al eliminar ciclo' });
    }
});

// ========================================
// RUTAS DE ESTADÍSTICAS Y REPORTES
// ========================================

// Obtener estadísticas generales
app.get('/api/estadisticas', authenticateToken, async (req, res) => {
    try {
        const stats = {};
        
        // Total de cursos activos
        const cursosActivos = await pool.query(
            'SELECT COUNT(*) FROM cegae_cursosdisponibles WHERE idestado = 1'
        );
        stats.cursosActivos = parseInt(cursosActivos.rows[0].count);
        
        // Total de ciclos activos
        const ciclosActivos = await pool.query(
            'SELECT COUNT(*) FROM cegae_cursosdisponiblesciclo WHERE idestado = 1'
        );
        stats.ciclosActivos = parseInt(ciclosActivos.rows[0].count);
        
        // Ciclos próximos a iniciar (próximos 30 días)
        const ciclosProximos = await pool.query(
            `SELECT COUNT(*) FROM cegae_cursosdisponiblesciclo 
             WHERE fecha_inicio_clase BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
             AND idestado = 1`
        );
        stats.ciclosProximos = parseInt(ciclosProximos.rows[0].count);
        
        // Ciclos en curso
        const ciclosEnCurso = await pool.query(
            `SELECT COUNT(*) FROM cegae_cursosdisponiblesciclo 
             WHERE CURRENT_DATE BETWEEN fecha_inicio_clase AND fecha_fin_clase
             AND idestado = 1`
        );
        stats.ciclosEnCurso = parseInt(ciclosEnCurso.rows[0].count);
        
        res.json(stats);
    } catch (error) {
        console.error('Error al obtener estadísticas:', error);
        res.status(500).json({ error: 'Error al obtener estadísticas' });
    }
});


app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy' });
});


// ========================================
// INICIALIZACIÓN DEL SERVIDOR
// ========================================

app.listen(PORT, '0.0.0.0', async () => {
    console.log(`✅ Servidor ejecutándose en http://0.0.0.0:${PORT}`);
    try {
        console.log('✅ Base de datos inicializada');
    } catch (error) {
        console.error('❌ Error al inicializar base de datos:', error);
    }
});

// Manejo de errores no capturados
process.on('unhandledRejection', (err) => {
    console.error('❌ Error no manejado:', err);
});