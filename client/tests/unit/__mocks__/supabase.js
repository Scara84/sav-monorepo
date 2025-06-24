// Mock pour le client Supabase
export const supabase = {
  auth: {
    session: () => ({
      data: {
        session: {
          access_token: 'mock-access-token',
          user: {
            id: 'mock-user-id',
            email: 'test@example.com'
          }
        }
      }
    }),
    onAuthStateChange: (callback) => {
      // Simuler un changement d'état d'authentification
      const session = {
        data: {
          session: {
            access_token: 'mock-access-token',
            user: {
              id: 'mock-user-id',
              email: 'test@example.com'
            }
          }
        }
      };
      callback('SIGNED_IN', session);
      
      // Retourner une fonction de nettoyage
      return () => {};
    },
    signInWithPassword: async () => ({
      data: {
        user: { id: 'mock-user-id', email: 'test@example.com' },
        session: { access_token: 'mock-access-token' }
      },
      error: null
    }),
    signOut: async () => ({ error: null })
  },
  from: (table) => ({
    select: (columns = '*') => ({
      eq: (column, value) => ({
        data: [],
        error: null
      }),
      data: [],
      error: null
    }),
    insert: (data) => ({
      select: () => ({
        data: [data],
        error: null
      })
    }),
    update: (data) => ({
      eq: () => ({
        select: () => ({
          data: [data],
          error: null
        })
      })
    }),
    delete: () => ({
      eq: () => ({
        data: [],
        error: null
      })
    })
  }),
  storage: {
    from: (bucket) => ({
      upload: async (path, file) => ({
        data: { path: `${bucket}/${path}` },
        error: null
      }),
      getPublicUrl: (path) => ({
        data: { publicUrl: `https://example.com/${path}` }
      })
    })
  },
  rpc: async (fn, params) => ({
    data: null,
    error: null
  })
};

export default supabase;
